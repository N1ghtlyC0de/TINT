package server

import (
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func replica(t *testing.T, mr *miniredis.Miniredis, secret string) string {
	t.Helper()
	env := map[string]string{"REDIS_URL": "redis://" + mr.Addr(), "JWT_SECRET": secret}
	srv := httptest.NewServer(NewRouterWithDeps(DefaultDeps(func(k string) string { return env[k] })))
	t.Cleanup(srv.Close)
	return "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
}

// Las reacciones solo se emitían en la réplica local: con más de una
// réplica no llegaban a los usuarios conectados a las demás. Ahora viajan
// por el mismo canal Redis que el chat, con dedup por event_id.
func TestReactionsReachOtherReplicasOnce(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	urlA, urlB := replica(t, mr, secret), replica(t, mr, secret)
	exp := time.Now().Add(time.Hour)

	a := dial(t, urlA, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dial(t, urlB, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")
	colA, colB := collectConn(a), collectConn(b)
	// Ambas réplicas suscritas antes de reaccionar.
	deadline := time.Now().Add(5 * time.Second)
	for mr.PubSubNumSub(chat.ChannelKey("r1"))[chat.ChannelKey("r1")] < 2 {
		if time.Now().After(deadline) {
			t.Fatal("las réplicas no se suscribieron")
		}
		runtime.Gosched()
	}

	sendRaw(t, a, socialevent.ReactionSend{
		EventID: "e1", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: "👏", PositionMS: 1000, OccurredAt: time.Now().UTC(),
	})
	for name, col := range map[string]*collector{"A": colA, "B": colB} {
		reactions := 0
		for {
			m, ok := col.next(500 * time.Millisecond)
			if !ok {
				break
			}
			if m["type"] == "reaction" {
				reactions++
				if m["emoji"] != "👏" || m["nick"] != "Ana" {
					t.Fatalf("%s reacción = %v", name, m)
				}
			}
		}
		if reactions != 1 {
			t.Fatalf("%s recibió %d reacciones, want exactamente 1", name, reactions)
		}
	}
}
