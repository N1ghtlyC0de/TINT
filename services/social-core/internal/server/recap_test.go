package server

import (
	"context"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/recap"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// recapReplica arranca una réplica con Redis que cuenta los eventos de
// sync procesados (hook fijado antes de arrancar el servidor).
func recapReplica(t *testing.T, mr *miniredis.Miniredis, secret string, processed *atomic.Int64) string {
	t.Helper()
	env := map[string]string{"REDIS_URL": "redis://" + mr.Addr(), "JWT_SECRET": secret}
	deps := DefaultDeps(func(k string) string { return env[k] })
	deps.AfterFunc = (&fakeTimers{}).AfterFunc
	deps.syncHook = func(recap.Kind) { processed.Add(1) }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	t.Cleanup(srv.Close)
	return "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
}

func react(t *testing.T, c *websocket.Conn, col *collector, emoji string, pos int64) {
	t.Helper()
	sendRaw(t, c, socialevent.ReactionSend{
		EventID: "r", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: emoji, PositionMS: pos, OccurredAt: time.Now().UTC(),
	})
	nextOfType(t, col, "reaction")
}

func TestRecapAcrossReplicas(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	var processed atomic.Int64
	urlA, urlB := recapReplica(t, mr, secret, &processed), recapReplica(t, mr, secret, &processed)
	h, colH := joinCol(t, urlA, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	g, colG := joinCol(t, urlB, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	waitSubs(t, mr, chat.SyncChannelKey("r1"), 2)

	// Recap vacío: secciones en null.
	sendRaw(t, g, socialevent.RecapRequest{EventID: "q0", Type: socialevent.TypeRecapRequest})
	if m := nextOfType(t, colG, "recap"); m["top_emoji_user"] != nil || m["most_paused"] != nil || m["peak_reactions"] != nil {
		t.Fatalf("recap vacío = %v", m)
	}

	react(t, g, colG, "😂", 12_000)
	react(t, g, colG, "😂", 13_000)
	react(t, h, colH, "👏", 1_000)

	// sync-core publica comandos en room:{id}:sync; ambas réplicas los ven
	// pero cada event_id se cuenta una sola vez.
	pub := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer pub.Close()
	events := []string{
		`{"event_id":"s1","type":"PLAY","room_id":"r1","position_ms":0,"status":"playing","rate":1,"updated_at_ms":1000000,"version":1}`,
		`{"event_id":"s2","type":"PAUSE","room_id":"r1","position_ms":61000,"status":"paused","rate":1,"updated_at_ms":1061000,"version":2}`,
		`{"event_id":"s3","type":"SEEK","room_id":"r1","position_ms":60500,"status":"paused","rate":1,"updated_at_ms":1062000,"version":3}`,
		`{"event_id":"s4","type":"SEEK","room_id":"r1","position_ms":40000,"status":"paused","rate":1,"updated_at_ms":1063000,"version":4}`,
		`{"event_id":"s5","type":"HEARTBEAT","room_id":"r1","position_ms":0}`,
	}
	for _, ev := range events {
		if err := pub.Publish(context.Background(), chat.SyncChannelKey("r1"), ev).Err(); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for processed.Load() < 8 { // 4 comandos × 2 réplicas (HEARTBEAT se ignora)
		if time.Now().After(deadline) {
			t.Fatalf("eventos de sync procesados = %d, want 8", processed.Load())
		}
		runtime.Gosched()
	}

	// El host lanza una encuesta: cuenta para el recap.
	createPoll(t, h, 30)
	nextOfType(t, colH, "poll_state")
	nextOfType(t, colG, "poll_state")

	sendRaw(t, g, socialevent.RecapRequest{EventID: "q1", Type: socialevent.TypeRecapRequest, RoomID: "r1"})
	m := nextOfType(t, colG, "recap")
	top, _ := m["top_emoji_user"].(map[string]any)
	if top["user_id"] != "guest:beto" || top["nick"] != "Beto" || top["count"] != float64(2) {
		t.Fatalf("top_emoji_user = %v", m["top_emoji_user"])
	}
	peak, _ := m["peak_reactions"].(map[string]any)
	if peak["position_ms"] != float64(10_000) || peak["count"] != float64(2) || peak["laughs"] != float64(2) {
		t.Fatalf("peak_reactions = %v", m["peak_reactions"])
	}
	most, _ := m["most_paused"].(map[string]any)
	// Empate entre la pausa (bucket 60 s) y el rebobinado (40 s): gana el
	// más temprano. El SEEK a 60,5 s (0,5 s atrás) queda en la tolerancia.
	if most["count"] != float64(1) || most["position_ms"] != float64(40_000) {
		t.Fatalf("most_paused = %v", m["most_paused"])
	}
	totals, _ := m["totals"].(map[string]any)
	if totals["reactions"] != float64(3) || totals["pauses"] != float64(1) || totals["rewinds"] != float64(1) || totals["polls"] != float64(1) {
		t.Fatalf("totals = %v, want 3 reacciones, 1 pausa, 1 rebobinado, 1 encuesta", totals)
	}
	if m["room_id"] != "r1" || m["event_id_ref"] != "q1" {
		t.Fatalf("recap = %v", m)
	}
	// Solo lo recibe quien lo pidió.
	noneOfType(t, colH, "recap")

	sendRaw(t, g, map[string]any{"type": "recap_request"})
	if m := nextOfType(t, colG, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("sin event_id = %v", m)
	}
}

func TestRecapUnavailableWithoutRedis(t *testing.T) {
	const secret = "s3cr3t"
	url := laserURL(t, testDeps(secret))
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	sendRaw(t, g, socialevent.RecapRequest{EventID: "q", Type: socialevent.TypeRecapRequest})
	if m := nextOfType(t, colG, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("recap sin Redis = %v, want UNAVAILABLE", m)
	}
}

func TestRecapRequestRateLimited(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	for i := 0; i < PollActionsPerSecond; i++ {
		sendRaw(t, g, socialevent.RecapRequest{EventID: "q", Type: socialevent.TypeRecapRequest})
		nextOfType(t, colG, "recap")
	}
	sendRaw(t, g, socialevent.RecapRequest{EventID: "spam", Type: socialevent.TypeRecapRequest})
	if m := nextOfType(t, colG, "error"); m["code"] != "RATE_LIMITED" {
		t.Fatalf("recap spam = %v, want RATE_LIMITED", m)
	}
	mr.Close()
	clock.Advance(2 * time.Second)
	sendRaw(t, g, socialevent.RecapRequest{EventID: "down", Type: socialevent.TypeRecapRequest})
	if m := nextOfType(t, colG, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("recap con Redis caído = %v, want UNAVAILABLE", m)
	}
}
