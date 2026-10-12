package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/analytics"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// recv espera un valor de un canal de fakes sin tocar las conexiones.
func recv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		var zero T
		t.Fatalf("no llegó %s (timeout)", what)
		return zero
	}
}

func expectNone[T any](t *testing.T, ch <-chan T, what string) {
	t.Helper()
	select {
	case v := <-ch:
		t.Fatalf("%s inesperado = %+v", what, v)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestSocialTracksChatWithUserAndReceivedAt(t *testing.T) {
	secret := "s3cr3t"
	fixed := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	deps := testDeps(secret)
	deps.Now = func() time.Time { return fixed }
	chats := make(chan analytics.ChatMessage, 4)
	deps.TrackChat = func(m analytics.ChatMessage) { chats <- m }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	_ = readJSON(t, c) // notice joined propio

	past := fixed.Add(-2 * time.Second)
	sendRaw(t, c, socialevent.ChatSend{
		EventID: "c1", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "  héllo  ", OccurredAt: past,
	})
	got := readJSON(t, c)
	m := recv(t, chats, "chat_message")
	if m.EventID != got["event_id"] || m.RoomID != "r1" || m.UserID != "guest:a" || m.MessageLength != 5 {
		t.Fatalf("chat tracked = %+v, broadcast = %v", m, got)
	}
	if !m.OccurredAt.Equal(past) || !m.ReceivedAt.Equal(fixed) {
		t.Fatalf("occurred/received = %v / %v, want %v / %v", m.OccurredAt, m.ReceivedAt, past, fixed)
	}
	// Un mensaje rechazado no se registra.
	sendRaw(t, c, socialevent.ChatSend{EventID: "c2", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "   "})
	if e := readJSON(t, c); e["type"] != "error" {
		t.Fatalf("vacío = %v, want error", e)
	}
	expectNone(t, chats, "chat_message")
}

func TestSocialTracksPresenceJoinAndLeave(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 50 * time.Millisecond
	presence := make(chan analytics.Presence, 8)
	deps.TrackPresence = func(p analytics.Presence) { presence <- p }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	colA := collectConn(a)
	if m, ok := colA.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	noticeA := expectNoticeCol(t, colA, "joined", "Ana")
	p := recv(t, presence, "presence joined Ana")
	if p.Kind != analytics.PresenceJoined || p.UserID != "guest:ana" || p.RoomID != "r1" || p.ConnectedUsers != 1 {
		t.Fatalf("presence = %+v, want joined Ana con 1", p)
	}
	if p.EventID != noticeA["event_id"] || p.OccurredAt.IsZero() || !p.OccurredAt.Equal(p.ReceivedAt) {
		t.Fatalf("presence = %+v, want event_id del aviso y fechas del servidor", p)
	}

	b := dial(t, wsBase, guestTokenAs(t, secret, "guest:pedro", "Pedro", "r1", exp))
	if m := readJSON(t, b); m["type"] != "history" {
		t.Fatalf("primer mensaje B = %v", m)
	}
	expectNoticeCol(t, colA, "joined", "Pedro")
	if p := recv(t, presence, "presence joined Pedro"); p.Kind != analytics.PresenceJoined || p.UserID != "guest:pedro" || p.ConnectedUsers != 2 {
		t.Fatalf("presence = %+v, want joined Pedro con 2", p)
	}

	// Segunda pestaña de Ana: sin aviso, sin evento.
	a2 := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	if m := readJSON(t, a2); m["type"] != "history" {
		t.Fatalf("primer mensaje A2 = %v", m)
	}
	_ = a2.Close(websocket.StatusNormalClosure, "")
	expectNone(t, presence, "presence por multipestaña")

	if err := b.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}
	left := expectNoticeCol(t, colA, "left", "Pedro")
	p = recv(t, presence, "presence left Pedro")
	if p.Kind != analytics.PresenceLeft || p.UserID != "guest:pedro" || p.ConnectedUsers != 1 || p.EventID != left["event_id"] {
		t.Fatalf("presence = %+v, want left Pedro con 1", p)
	}
}

func TestSocialTracksAcceptedReactionsOnly(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	reacts := make(chan analytics.Reaction, 16)
	deps.TrackReaction = func(r analytics.Reaction) { reacts <- r }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	_ = readJSON(t, c) // notice joined propio

	// Emoji inválido: no se registra.
	sendRaw(t, c, socialevent.ReactionSend{EventID: "bad", Type: socialevent.TypeReactionSend, RoomID: "r1", Emoji: "🍕"})
	if e := readJSON(t, c); e["type"] != "error" {
		t.Fatalf("emoji inválido = %v", e)
	}
	for i := 0; i < 5; i++ {
		sendRaw(t, c, socialevent.ReactionSend{
			EventID: "e", Type: socialevent.TypeReactionSend, RoomID: "r1",
			Emoji: "👏", PositionMS: 12000, OccurredAt: time.Now().UTC(),
		})
		got := readJSON(t, c)
		r := recv(t, reacts, "reaction")
		if r.EventID != got["event_id"] || r.UserID != "guest:a" || r.RoomID != "r1" || r.Emoji != "👏" || r.PositionMS != 12000 {
			t.Fatalf("reaction tracked = %+v, broadcast = %v", r, got)
		}
		if r.ReceivedAt.IsZero() || r.OccurredAt.After(r.ReceivedAt) {
			t.Fatalf("fechas = %v / %v", r.OccurredAt, r.ReceivedAt)
		}
	}
	// Sexta en el mismo segundo: RATE_LIMITED y sin evento.
	sendRaw(t, c, socialevent.ReactionSend{EventID: "spam", Type: socialevent.TypeReactionSend, RoomID: "r1", Emoji: "👏", OccurredAt: time.Now().UTC()})
	if e := readJSON(t, c); e["code"] != "RATE_LIMITED" {
		t.Fatalf("sexta = %v, want RATE_LIMITED", e)
	}
	expectNone(t, reacts, "reaction limitada")
}

// De punta a punta con Redis (miniredis): los campos que llegan al stream
// son los del contrato y nunca el texto ni el nick.
func TestSocialAnalyticsReachStream(t *testing.T) {
	secret := "s3cr3t"
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	em := analytics.New(client, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go em.Run(ctx)

	deps := testDeps(secret)
	deps.useAnalytics(em)
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	_ = readJSON(t, c) // notice joined propio
	sendRaw(t, c, socialevent.ChatSend{EventID: "c1", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "secreto", OccurredAt: time.Now().UTC()})
	chatOut := readJSON(t, c)
	sendRaw(t, c, socialevent.ReactionSend{EventID: "r1", Type: socialevent.TypeReactionSend, RoomID: "r1", Emoji: "😂", PositionMS: 7000, OccurredAt: time.Now().UTC()})
	reactOut := readJSON(t, c)

	byType := waitStream(t, client, 3)
	common := func(ev map[string]any, typ string) {
		t.Helper()
		if ev["source"] != "social-core" || ev["room_id"] != "r1" || ev["user_id"] != "guest:ana" {
			t.Fatalf("%s = %v, want campos comunes", typ, ev)
		}
		for _, k := range []string{"occurred_at", "received_at"} {
			s, _ := ev[k].(string)
			if _, err := time.Parse(time.RFC3339, s); err != nil || !strings.HasSuffix(s, "Z") || len(s) != len("2026-10-11T04:29:49.368Z") {
				t.Fatalf("%s.%s = %q, want RFC 3339 UTC con ms", typ, k, s)
			}
		}
		for _, k := range []string{"text", "nick"} {
			if _, ok := ev[k]; ok {
				t.Fatalf("%s lleva %s: %v", typ, k, ev)
			}
		}
	}
	p := byType["presence"]
	common(p, "presence")
	if p["kind"] != "joined" || p["connected_users"] != "1" {
		t.Fatalf("presence = %v", p)
	}
	ch := byType["chat_message"]
	common(ch, "chat_message")
	if ch["message_length"] != "7" || ch["event_id"] != chatOut["event_id"] {
		t.Fatalf("chat_message = %v", ch)
	}
	r := byType["reaction"]
	common(r, "reaction")
	if r["emoji"] != "😂" || r["position_ms"] != "7000" || r["event_id"] != reactOut["event_id"] {
		t.Fatalf("reaction = %v", r)
	}
}

// waitStream espera n entradas en analytics:events y las indexa por type.
func waitStream(t *testing.T, client *redis.Client, n int) map[string]map[string]any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		entries, err := client.XRange(context.Background(), analytics.StreamKey, "-", "+").Result()
		if err == nil && len(entries) >= n {
			out := make(map[string]map[string]any, len(entries))
			for _, e := range entries {
				out[e.Values["type"].(string)] = e.Values
			}
			return out
		}
		select {
		case <-deadline:
			t.Fatalf("stream con %d entradas, want %d", len(entries), n)
		case <-tick.C:
		}
	}
}
