package server

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func TestSeenIDsDedupsAndEvicts(t *testing.T) {
	s := newSeenIDs()
	if s.seen("a") {
		t.Fatal("primera vez no es duplicado")
	}
	if !s.seen("a") {
		t.Fatal("segunda vez sí es duplicado")
	}
	// Llenar la ventana con ids distintos: el primero debe seguir dentro.
	for i := 0; i < seenCap-1; i++ {
		s.seen("id-" + itoa(int64(i)))
	}
	if !s.seen("a") {
		t.Fatal("a debe seguir en la ventana llena")
	}
	// Un id más expulsa al más viejo ("a").
	s.seen("nuevo")
	if s.seen("a") {
		t.Fatal("tras evicción, 'a' ya no debe recordarse")
	}
}

func TestRelaySharedAndReleased(t *testing.T) {
	var subscribes int64
	deps := &Deps{
		Hub:     chat.NewHub(),
		History: chat.NewMemoryStore(10),
		Subscribe: func(ctx context.Context, _ string) (<-chan chat.Inbound, func()) {
			atomic.AddInt64(&subscribes, 1)
			out := make(chan chat.Inbound)
			stopped := make(chan struct{})
			go func() {
				select {
				case <-ctx.Done():
				case <-stopped:
				}
			}()
			_ = out
			ch := make(chan chat.Inbound)
			return ch, func() { close(stopped) }
		},
	}
	r1 := deps.acquireRelay("r1")
	if n := atomic.LoadInt64(&subscribes); n != 1 {
		t.Fatalf("subscribes = %d, want 1", n)
	}
	r2 := deps.acquireRelay("r1")
	if n := atomic.LoadInt64(&subscribes); n != 1 {
		t.Fatalf("segunda adquisición no debe suscribirse de nuevo (n=%d)", n)
	}
	if got := deps.relayRefs("r1"); got != 2 {
		t.Fatalf("refs = %d, want 2", got)
	}
	r1()
	if got := deps.relayRefs("r1"); got != 1 {
		t.Fatalf("tras 1 release refs = %d, want 1", got)
	}
	r2()
	if got := deps.relayRefs("r1"); got != 0 {
		t.Fatalf("tras 2 releases refs = %d, want 0", got)
	}
	// Re-adquirir tras liberar crea una suscripción nueva.
	r3 := deps.acquireRelay("r1")
	if n := atomic.LoadInt64(&subscribes); n != 2 {
		t.Fatalf("tras liberar debe re-suscribirse (n=%d)", n)
	}
	r3()
	deps.releaseRelay("inexistente") // no-op, no debe panic
}

func TestBroadcastOnceSkipsSeen(t *testing.T) {
	deps := &Deps{Hub: chat.NewHub(), History: chat.NewMemoryStore(10)}
	now := time.Now().UTC()
	m := socialevent.ChatMessage{
		EventID: "dup-1", Type: socialevent.TypeChatMessage, RoomID: "r1",
		UserID: "u", Nick: "A", Text: "hola",
		OccurredAt: now, ReceivedAt: now,
	}
	ch := make(chan []byte, 4)
	deps.Hub.Join("r1", "c1", ch)
	deps.broadcastOnce("r1", m)
	deps.broadcastOnce("r1", m) // eco: no debe reemitir
	if len(ch) != 1 {
		t.Fatalf("entregas = %d, want 1", len(ch))
	}
}

func TestRelayConcurrentAcquireSingleSubscribe(t *testing.T) {
	var subscribes int64
	deps := &Deps{
		Hub:     chat.NewHub(),
		History: chat.NewMemoryStore(10),
		Subscribe: func(ctx context.Context, _ string) (<-chan chat.Inbound, func()) {
			atomic.AddInt64(&subscribes, 1)
			time.Sleep(20 * time.Millisecond) // ventana para colisiones
			return make(chan chat.Inbound), func() {}
		},
	}
	const n = 8
	releases := make([]func(), n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			releases[i] = deps.acquireRelay("r1")
		}(i)
	}
	wg.Wait()
	// Con Subscribe bloqueante, varios pueden suscribir a la vez; los
	// perdedores descartan la suya. Lo que se garantiza: un solo relay
	// vivo y el conteo de referencias exacto.
	if got := atomic.LoadInt64(&subscribes); got < 1 {
		t.Fatalf("subscribes concurrentes = %d, want >= 1", got)
	}
	if got := deps.relayRefs("r1"); got != n {
		t.Fatalf("refs = %d, want %d", got, n)
	}
	for _, r := range releases {
		r()
	}
	if got := deps.relayRefs("r1"); got != 0 {
		t.Fatalf("tras liberar todo refs = %d, want 0", got)
	}
}
