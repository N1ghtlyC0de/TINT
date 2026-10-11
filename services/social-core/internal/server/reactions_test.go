package server

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func TestSocialReactionBroadcast(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	deps.ReactionBuckets = reactions.NewBuckets()
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	colA := collectConn(a)
	if m, ok := colA.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje A = %v, want history", m)
	}
	expectNoticeCol(t, colA, "joined", "Ana")

	b := dial(t, wsBase, guestTokenAs(t, secret, "guest:pedro", "Pedro", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")
	colB := collectConn(b)
	if m, ok := colB.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje B = %v, want history", m)
	}
	expectNoticeCol(t, colB, "joined", "Pedro")
	expectNoticeCol(t, colA, "joined", "Pedro")

	sendRaw(t, a, socialevent.ReactionSend{
		EventID: "e1", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: "👏", PositionMS: 12000, OccurredAt: time.Now().UTC(),
	})
	for name, col := range map[string]*collector{"A": colA, "B": colB} {
		m, ok := col.next(5 * time.Second)
		if !ok {
			t.Fatalf("%s no recibió la reacción", name)
		}
		if m["type"] != "reaction" || m["emoji"] != "👏" || m["nick"] != "Ana" {
			t.Fatalf("%s = %v, want reaction 👏 de Ana", name, m)
		}
		if m["position_ms"] != float64(12000) {
			t.Fatalf("%s = %v, want position_ms 12000", name, m)
		}
		if m["user_id"] != "guest:ana" || m["room_id"] != "r1" {
			t.Fatalf("%s = %v, want user/room", name, m)
		}
	}

	// La reacción cae al bucket de 5s (12000ms -> bucket 2), sin historial.
	if got := deps.ReactionBuckets.Count("r1", 2, "👏"); got != 1 {
		t.Fatalf("bucket(2,👏) = %d, want 1", got)
	}
}

func TestSocialReactionRateLimited(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	deps.ReactionLimit = reactions.NewLimiter()
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp0()))
	defer c.Close(websocket.StatusNormalClosure, "")
	col := collectConn(c)
	if m, ok := col.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	expectNoticeCol(t, col, "joined", "Ana")

	for i := 0; i < 5; i++ {
		sendRaw(t, c, socialevent.ReactionSend{
			EventID: "e", Type: socialevent.TypeReactionSend, RoomID: "r1",
			Emoji: "❤️", PositionMS: 0, OccurredAt: time.Now().UTC(),
		})
		m, ok := col.next(5 * time.Second)
		if !ok || m["type"] != "reaction" {
			t.Fatalf("reacción %d = %v, want reaction", i+1, m)
		}
	}
	sendRaw(t, c, socialevent.ReactionSend{
		EventID: "spam", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: "❤️", PositionMS: 0, OccurredAt: time.Now().UTC(),
	})
	m, ok := col.next(5 * time.Second)
	if !ok || m["type"] != "error" || m["code"] != "RATE_LIMITED" {
		t.Fatalf("sexta reacción = %v, want RATE_LIMITED", m)
	}
}

func exp0() time.Time { return time.Now().Add(time.Hour) }

func TestSocialReactionInvalidEmoji(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp0()))
	defer c.Close(websocket.StatusNormalClosure, "")
	col := collectConn(c)
	if m, ok := col.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	expectNoticeCol(t, col, "joined", "Ana")

	sendRaw(t, c, socialevent.ReactionSend{
		EventID: "bad", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: "💩", PositionMS: 0, OccurredAt: time.Now().UTC(),
	})
	m, ok := col.next(5 * time.Second)
	if !ok || m["type"] != "error" || m["code"] != "INVALID_EMOJI" {
		t.Fatalf("emoji inválido = %v, want INVALID_EMOJI", m)
	}
}
