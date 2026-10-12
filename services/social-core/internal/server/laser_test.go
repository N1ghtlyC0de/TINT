package server

import (
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// roleTicket firma un HS256 como el sync-ticket de identity-api (rol dado).
func roleTicket(t *testing.T, secret, sub, nick, role, room string) string {
	t.Helper()
	return signGuestToken(t, secret, map[string]any{
		"sub": sub, "room_id": room, "role": role, "nick": nick,
		"jti": "jti-" + sub, "iss": "tint-identity", "aud": "tint:room", "exp": time.Now().Add(time.Hour).Unix(),
	})
}

// joinCol conecta y consume history + notice propio.
func joinCol(t *testing.T, url, token string) (*websocket.Conn, *collector) {
	t.Helper()
	c := dial(t, url, token)
	col := collectConn(c)
	if m, ok := col.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	return c, col
}

// nextOfType descarta mensajes de otros tipos (notices) hasta el buscado.
func nextOfType(t *testing.T, col *collector, typ string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		m, ok := col.next(time.Until(deadline))
		if !ok {
			break
		}
		if m["type"] == typ {
			return m
		}
	}
	t.Fatalf("no llegó un mensaje %s", typ)
	return nil
}

// noneOfType comprueba que en una ventana corta no llega ese tipo.
func noneOfType(t *testing.T, col *collector, typ string) {
	t.Helper()
	for {
		m, ok := col.next(300 * time.Millisecond)
		if !ok {
			return
		}
		if m["type"] == typ {
			t.Fatalf("llegó %v, want ningún %s", m, typ)
		}
	}
}

func laserURL(t *testing.T, deps *Deps) string {
	t.Helper()
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	t.Cleanup(srv.Close)
	return "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
}

func TestIsModerator(t *testing.T) {
	cases := []struct {
		name string
		c    auth.Claims
		want bool
	}{
		{"host con ticket de la sala", auth.Claims{Role: "host", RoomID: "r1", IsGuest: true}, true},
		{"cohost de la sala", auth.Claims{Role: "cohost", RoomID: "r1", IsGuest: true}, true},
		{"participante", auth.Claims{Role: "participant", RoomID: "r1", IsGuest: true}, false},
		{"host de otra sala", auth.Claims{Role: "host", RoomID: "r2", IsGuest: true}, false},
		// Un Firebase ID token no está ligado a ninguna sala: no prueba ser
		// dueño de esta (falla cerrado; el host usa su sync-ticket).
		{"firebase sin sala", auth.Claims{Role: "host"}, false},
	}
	for _, tc := range cases {
		if got := isModerator(tc.c, "r1"); got != tc.want {
			t.Errorf("%s: isModerator = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestLaserHostBroadcastsToRoom(t *testing.T) {
	const secret = "s3cr3t"
	url := laserURL(t, testDeps(secret))
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")

	sendRaw(t, h, socialevent.LaserPoint{EventID: "l1", Type: socialevent.TypeLaserPoint, RoomID: "r1", X: 0.25, Y: 0.75})
	for name, col := range map[string]*collector{"host": colH, "guest": colG} {
		m := nextOfType(t, col, "laser")
		if m["user_id"] != "host-1" || m["nick"] != "Ana" || m["x"] != 0.25 || m["y"] != 0.75 || m["end"] != false {
			t.Fatalf("%s laser = %v", name, m)
		}
		if m["event_id"] == "" || m["event_id"] == "l1" || m["room_id"] != "r1" {
			t.Fatalf("%s laser = %v, want event_id del servidor y room_id", name, m)
		}
	}
	sendRaw(t, h, socialevent.LaserPoint{EventID: "l2", Type: socialevent.TypeLaserPoint, X: 0.3, Y: 0.3, End: true})
	if m := nextOfType(t, colG, "laser"); m["end"] != true {
		t.Fatalf("laser end = %v, want end true", m)
	}
}

func TestLaserForbiddenForParticipant(t *testing.T) {
	const secret = "s3cr3t"
	url := laserURL(t, testDeps(secret))
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	sendRaw(t, g, socialevent.LaserPoint{EventID: "l1", Type: socialevent.TypeLaserPoint, X: 0.5, Y: 0.5})
	m := nextOfType(t, colG, "error")
	if m["code"] != "FORBIDDEN" || m["event_id_ref"] != "l1" {
		t.Fatalf("error = %v, want FORBIDDEN l1", m)
	}
	noneOfType(t, colG, "laser")
}

func TestLaserInvalidPayload(t *testing.T) {
	const secret = "s3cr3t"
	url := laserURL(t, testDeps(secret))
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	sendRaw(t, h, socialevent.LaserPoint{EventID: "l1", Type: socialevent.TypeLaserPoint, X: 1.5, Y: 0.5})
	if m := nextOfType(t, colH, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("x fuera de rango = %v, want INVALID_PAYLOAD", m)
	}
	sendRaw(t, h, socialevent.LaserPoint{EventID: "l2", Type: socialevent.TypeLaserPoint, RoomID: "otra", X: 0.5, Y: 0.5})
	if m := nextOfType(t, colH, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("otra sala = %v, want INVALID_PAYLOAD", m)
	}
	sendRaw(t, h, map[string]any{"type": "laser_point", "event_id": "l3", "x": "mucho"})
	if m := nextOfType(t, colH, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("x no numérica = %v, want INVALID_PAYLOAD", m)
	}
}

func TestLaserRateLimited30PerSecond(t *testing.T) {
	const secret = "s3cr3t"
	fixed := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	deps := testDeps(secret)
	deps.Now = func() time.Time { return fixed }
	url := laserURL(t, deps)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	for i := 0; i < 30; i++ {
		sendRaw(t, h, socialevent.LaserPoint{EventID: "l", Type: socialevent.TypeLaserPoint, X: 0.1, Y: 0.1})
		nextOfType(t, colH, "laser")
	}
	sendRaw(t, h, socialevent.LaserPoint{EventID: "spam", Type: socialevent.TypeLaserPoint, X: 0.1, Y: 0.1})
	if m := nextOfType(t, colH, "error"); m["code"] != "RATE_LIMITED" || m["event_id_ref"] != "spam" {
		t.Fatalf("punto 31 = %v, want RATE_LIMITED", m)
	}
}

func waitSubs(t *testing.T, mr *miniredis.Miniredis, channel string, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for mr.PubSubNumSub(channel)[channel] < n {
		if time.Now().After(deadline) {
			t.Fatalf("menos de %d suscriptores en %s", n, channel)
		}
		runtime.Gosched()
	}
}

func TestLaserReachesOtherReplicasOnce(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	urlA, urlB := replica(t, mr, secret), replica(t, mr, secret)
	h, colH := joinCol(t, urlA, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	g, colG := joinCol(t, urlB, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	waitSubs(t, mr, chat.ChannelKey("r1"), 2)

	sendRaw(t, h, socialevent.LaserPoint{EventID: "l1", Type: socialevent.TypeLaserPoint, X: 0.5, Y: 0.4})
	for name, col := range map[string]*collector{"A": colH, "B": colG} {
		m := nextOfType(t, col, "laser")
		if m["nick"] != "Ana" || m["y"] != 0.4 {
			t.Fatalf("%s laser = %v", name, m)
		}
		noneOfType(t, col, "laser")
	}
}
