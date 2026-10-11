package server

import (
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
)

// Sin ping ni timeouts, una conexión muerta (cliente que deja de leer o red
// caída) quedaba en la sala para siempre y nunca se emitía su "salió".
// El ping periódico la detecta, la cierra y dispara el aviso de salida.
func TestSocialDropsUnresponsiveClient(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 10 * time.Millisecond
	// Holgura para que B (que sí lee) conteste a tiempo incluso con -race.
	deps.PingInterval = 50 * time.Millisecond
	deps.PingTimeout = 500 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	b := dial(t, wsBase, guestTokenAs(t, secret, "guest:b", "Beto", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")
	colB := collectConn(b) // B lee siempre: responde los pings
	if m, ok := colB.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("B history = %v", m)
	}
	expectNoticeCol(t, colB, "joined", "Beto")

	// A nunca lee: no contesta pings (como un cliente colgado o sin red).
	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:a", "Ana", "r1", exp))
	defer a.CloseNow()
	expectNoticeCol(t, colB, "joined", "Ana")
	expectNoticeCol(t, colB, "left", "Ana")
	if n := deps.Hub.Members("r1"); n != 1 {
		t.Fatalf("miembros = %d, want 1 (solo B)", n)
	}
}

// Un cliente que no lee llena los buffers TCP: la escritura vence por plazo,
// se corta el socket y el handler termina (antes el escritor moría en
// silencio y la conexión quedaba en la sala).
func TestSocialWriteTimeoutDropsClient(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.WriteTimeout = 50 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	a := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)))
	defer a.CloseNow()

	big := []byte(`"` + strings.Repeat("x", 1<<20) + `"`)
	deadline := time.Now().Add(20 * time.Second)
	for deps.Hub.Members("r1") > 0 {
		if time.Now().After(deadline) {
			t.Fatal("el cliente que no lee sigue en la sala")
		}
		deps.Hub.Broadcast("r1", big)
		runtime.Gosched()
	}
}

// Las entradas de presencia nunca se borraban (memoria sin cota). Tras la
// gracia sin reingreso, la entrada y la sala vacía desaparecen.
func TestPresenceEntriesAreDeleted(t *testing.T) {
	d := testDeps("s")
	d.LeaveGrace = 5 * time.Millisecond
	claims := auth.Claims{Subject: "u1", Nick: "Ana"}
	d.presenceJoin("r1", "u1", d.now())
	d.presenceJoin("r1", "u2", d.now())
	d.presenceLeave("r1", claims)
	deadline := time.Now().Add(5 * time.Second)
	for d.presenceCount("r1") != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("presencia r1 = %d, want 1 (solo u2)", d.presenceCount("r1"))
		}
		runtime.Gosched()
	}
	d.presenceLeave("r1", auth.Claims{Subject: "u2", Nick: "Beto"})
	for d.presenceRooms() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("salas con presencia = %d, want 0", d.presenceRooms())
		}
		runtime.Gosched()
	}
}

func TestLivenessDefaults(t *testing.T) {
	d := &Deps{}
	if d.pingInterval() != DefaultPingInterval || d.pingTimeout() != DefaultPingTimeout || d.writeTimeout() != DefaultWriteTimeout {
		t.Fatalf("defaults = %v / %v / %v", d.pingInterval(), d.pingTimeout(), d.writeTimeout())
	}
}
