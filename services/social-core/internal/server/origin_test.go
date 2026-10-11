package server

import (
	"context"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func dialOrigin(t *testing.T, url, token, origin string) (int, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer " + token}, "Origin": {origin}},
	})
	if err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		return 101, nil
	}
	if resp == nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, err
}

// OriginPatterns ["*"] aceptaba cualquier sitio (CSWSH). Solo los orígenes
// de ALLOWED_ORIGINS abren el socket.
func TestSocialRejectsForeignOrigin(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.AllowedOrigins = []string{"localhost:5173"}
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	tok := guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour))

	if got, _ := dialOrigin(t, url, tok, "https://evil.example"); got != 403 {
		t.Fatalf("origen ajeno: status = %d, want 403", got)
	}
	if got, err := dialOrigin(t, url, tok, "http://localhost:5173"); got != 101 {
		t.Fatalf("origen permitido: status = %d (%v), want 101", got, err)
	}
}

func TestDefaultDepsAllowedOrigins(t *testing.T) {
	def := DefaultDeps(func(string) string { return "" })
	if want := []string{"localhost:5173", "127.0.0.1:5173"}; !reflect.DeepEqual(def.AllowedOrigins, want) {
		t.Fatalf("AllowedOrigins = %v, want %v", def.AllowedOrigins, want)
	}
	custom := DefaultDeps(func(k string) string {
		if k == "ALLOWED_ORIGINS" {
			return " tint.app , *.tint.app ,"
		}
		return ""
	})
	if want := []string{"tint.app", "*.tint.app"}; !reflect.DeepEqual(custom.AllowedOrigins, want) {
		t.Fatalf("AllowedOrigins = %v, want %v", custom.AllowedOrigins, want)
	}
}
