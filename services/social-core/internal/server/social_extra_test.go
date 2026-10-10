package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func hostToken(project string, exp time.Time) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(
		`{"sub":"host-1","name":"Host","aud":"` + project + `","iss":"https://securetoken.google.com/` + project + `","exp":` + expUnix(exp) + `}`))
	return "h." + payload + ".s"
}

func expUnix(t time.Time) string {
	raw, _ := json.Marshal(t.Unix())
	return string(raw)
}

func sendRaw(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	raw, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestSocialHostCanJoin(t *testing.T) {
	deps := testDeps("s")
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=cualquiera"
	c := dial(t, wsBase, hostToken("tint-login", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	if m := readJSON(t, c); m["type"] != "history" {
		t.Fatalf("host join = %v, want history", m)
	}
}

func TestSocialInvalidJSONAndRoomMismatch(t *testing.T) {
	secret := "s3cr3t"
	srv := httptest.NewServer(NewRouterWithDeps(testDeps(secret)))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte("{mal")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := readJSON(t, c); got["type"] != "error" || got["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("json malo = %v", got)
	}
	sendRaw(t, c, socialevent.ChatSend{
		EventID: "x", Type: socialevent.TypeChatSend, RoomID: "otra",
		Text: "hola", OccurredAt: time.Now().UTC(),
	})
	if got := readJSON(t, c); got["type"] != "error" {
		t.Fatalf("sala distinta = %v, want error", got)
	}
}

func TestSocialRateLimited(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.ChatLimit = reactions.NewLimiter()
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c)
	for i := 0; i < 5; i++ {
		sendRaw(t, c, socialevent.ChatSend{
			EventID: "e", Type: socialevent.TypeChatSend, RoomID: "r1",
			Text: "hola", OccurredAt: time.Now().UTC(),
		})
		_ = readJSON(t, c) // broadcast propio
	}
	sendRaw(t, c, socialevent.ChatSend{
		EventID: "spam", Type: socialevent.TypeChatSend, RoomID: "r1",
		Text: "spam", OccurredAt: time.Now().UTC(),
	})
	if got := readJSON(t, c); got["type"] != "error" || got["code"] != "RATE_LIMITED" {
		t.Fatalf("sexto mensaje = %v, want RATE_LIMITED", got)
	}
}

func TestSocialCallsPublishTrackAndRemote(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	var published, tracked int
	now := time.Now().UTC()
	deps.Publish = func(_ context.Context, _ string, _ socialevent.ChatMessage) error { published++; return nil }
	deps.Track = func(_ context.Context, _ string, _ int, _ string, _ time.Time) { tracked++ }
	deps.Subscribe = func(_ context.Context, _ string) (<-chan socialevent.ChatMessage, func()) {
		out := make(chan socialevent.ChatMessage, 4)
		out <- socialevent.ChatMessage{
			EventID: "rem-1", Type: socialevent.TypeChatMessage, RoomID: "r1",
			UserID: "otro", Nick: "Remoto", Text: "desde otra réplica",
			OccurredAt: now, ReceivedAt: now,
		}
		return out, func() {}
	}
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	// El mensaje remoto debe llegar vía broadcast.
	if got := readJSON(t, c); got["text"] != "desde otra réplica" {
		t.Fatalf("remoto = %v", got)
	}
	sendRaw(t, c, socialevent.ChatSend{
		EventID: "e1", Type: socialevent.TypeChatSend, RoomID: "r1",
		Text: "hola", OccurredAt: time.Now().UTC(),
	})
	if got := readJSON(t, c); got["type"] != "chat_message" {
		t.Fatalf("eco = %v", got)
	}
	_ = chat.HistoryKey
	if published != 1 || tracked != 1 {
		t.Fatalf("publish=%d track=%d, want 1/1", published, tracked)
	}
}
