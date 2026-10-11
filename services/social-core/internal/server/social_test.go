package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func guestToken(t *testing.T, secret, sub, room string, exp time.Time) string {
	t.Helper()
	return guestTokenAs(t, secret, sub, "Invitado", room, exp)
}

// signGuestToken firma claims HS256 como identity-api (incluye jti/iss/aud).
func signGuestToken(t *testing.T, secret string, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	raw, _ := json.Marshal(claims)
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(header + "." + body))
	return header + "." + body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func testDeps(secret string) *Deps {
	var n atomic.Int64
	return &Deps{
		Hub:               chat.NewHub(),
		History:           chat.NewMemoryStore(50),
		JWTSecret:         secret,
		FirebaseProjectID: "tint-login",
		Now:               func() time.Time { return time.Now().UTC() },
		NewID:             func() string { return "srv-conn-" + itoa(n.Add(1)) },
	}
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func dial(t *testing.T, url, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	opts := &websocket.DialOptions{}
	if token != "" {
		opts.HTTPHeader = map[string][]string{"Authorization": {"Bearer " + token}}
	}
	c, _, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

func readJSON(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, raw, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("invalid json %q: %v", raw, err)
	}
	return m
}

func TestSocialRequiresAuthAndRoom(t *testing.T) {
	srv := httptest.NewServer(NewRouterWithDeps(testDeps("s")))
	defer srv.Close()
	base := strings.TrimPrefix(srv.URL, "http://")

	// Sin room.
	if _, resp, err := websocket.Dial(context.Background(), "ws://"+base+"/ws/social", nil); err == nil {
		resp.Body.Close()
		t.Fatal("sin room_id debe fallar")
	}
	// Sin token.
	_, resp, err := websocket.Dial(context.Background(), "ws://"+base+"/ws/social?room_id=r1", nil)
	if err == nil {
		t.Fatal("sin token debe dar 401")
	} else if resp != nil && resp.StatusCode != 401 {
		t.Fatalf("sin token status = %v, want 401", resp.StatusCode)
	} else if resp == nil && !strings.Contains(err.Error(), "401") {
		t.Fatalf("sin token err = %v, want 401", err)
	} else if resp != nil {
		resp.Body.Close()
	}
}

func TestSocialGuestWrongRoomForbidden(t *testing.T) {
	srv := httptest.NewServer(NewRouterWithDeps(testDeps("s3cr3t")))
	defer srv.Close()
	base := strings.TrimPrefix(srv.URL, "http://")
	token := guestToken(t, "s3cr3t", "guest:1", "otra", time.Now().Add(time.Hour))
	_, resp, err := websocket.Dial(context.Background(), "ws://"+base+"/ws/social?room_id=r1", &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer " + token}},
	})
	if err == nil {
		resp.Body.Close()
		t.Fatal("guest de otra sala debe dar 403")
	}
	if resp == nil || resp.StatusCode != 403 {
		t.Fatalf("status = %v, want 403", resp)
	}
}

func TestSocialChatBroadcastAndHistory(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)
	a := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dial(t, wsBase, guestToken(t, secret, "guest:b", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")

	if m := readJSON(t, a); m["type"] != "history" {
		t.Fatalf("primer mensaje A = %v, want history", m)
	}
	if m := readJSON(t, a); m["type"] != "notice" || m["kind"] != "joined" {
		t.Fatalf("segundo mensaje A = %v, want notice joined propio", m)
	}
	if m := readJSON(t, b); m["type"] != "history" {
		t.Fatalf("primer mensaje B = %v, want history", m)
	}
	if m := readJSON(t, b); m["type"] != "notice" || m["kind"] != "joined" {
		t.Fatalf("segundo mensaje B = %v, want notice joined propio", m)
	}
	// A se entera de que B entró.
	if m := readJSON(t, a); m["type"] != "notice" || m["kind"] != "joined" || m["nick"] != "Invitado" {
		t.Fatalf("aviso en A = %v, want notice joined de B", m)
	}

	send := socialevent.ChatSend{
		EventID: "c1", Type: socialevent.TypeChatSend, RoomID: "r1",
		Text: "  Hola grupo  ", OccurredAt: time.Now().UTC(),
	}
	raw, _ := json.Marshal(send)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
	gotA := readJSON(t, a)
	gotB := readJSON(t, b)
	for name, got := range map[string]map[string]any{"A": gotA, "B": gotB} {
		if got["type"] != "chat_message" || got["text"] != "Hola grupo" {
			t.Fatalf("%s broadcast = %v, want chat_message trim", name, got)
		}
		if got["room_id"] != "r1" || got["nick"] != "Invitado" {
			t.Fatalf("%s = %v, want room/nick", name, got)
		}
	}

	// Tercer cliente recibe historial solo con el mensaje (los avisos
	// de presencia son solo en vivo, no se guardan).
	c := dial(t, wsBase, guestToken(t, secret, "guest:c", "r1", exp))
	defer c.Close(websocket.StatusNormalClosure, "")
	hist := readJSON(t, c)
	msgs, _ := hist["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("history messages = %v, want 1", hist)
	}
	if msg, _ := msgs[0].(map[string]any); msg["type"] != "chat_message" {
		t.Fatalf("history[0] = %v, want chat_message", msgs[0])
	}
}

func TestSocialRejectsTooLong(t *testing.T) {
	secret := "s3cr3t"
	srv := httptest.NewServer(NewRouterWithDeps(testDeps(secret)))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	_ = readJSON(t, c) // notice joined propio
	send := socialevent.ChatSend{
		EventID: "c9", Type: socialevent.TypeChatSend, RoomID: "r1",
		Text: strings.Repeat("x", socialevent.MaxTextRunes+1), OccurredAt: time.Now().UTC(),
	}
	raw, _ := json.Marshal(send)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := readJSON(t, c)
	if got["type"] != "error" || got["code"] != "TEXT_TOO_LONG" {
		t.Fatalf("respuesta = %v, want TEXT_TOO_LONG", got)
	}
}
