package hub

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

func decodeEvent(t *testing.T, raw []byte) syncevent.Event {
	t.Helper()
	var ev syncevent.Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		t.Fatalf("JSON inválido %s: %v", raw, err)
	}
	return ev
}

func TestStateCarriesCanControl(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	if st := next(t, connect(t, h, host)); st.CanControl == nil || !*st.CanControl {
		t.Errorf("host: STATE = %+v", st)
	}
	if st := next(t, connect(t, h, guest)); st.CanControl == nil || *st.CanControl {
		t.Errorf("participante: STATE = %+v", st)
	}
}

// UX: el HEARTBEAT informa al cliente su RTT y su último drift medido.
func TestHeartbeatCarriesRTTAndDrift(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)
	send(t, h, hc, cmd("e-play", syncevent.Play, 0))
	nextOf(t, g, syncevent.Play)

	beat := decodeEvent(t, mustTick(t, h, g))
	if beat.RTTMs != 0 || beat.DriftMs != 0 {
		t.Errorf("sin mediciones el HEARTBEAT no trae rtt/drift: %+v", beat)
	}
	e.clock.advance(80 * time.Millisecond)
	check := cmd("c1", syncevent.SyncCheck, 300) // maestro ≈ 40 → drift ≈ +260
	check["echo_server_ts"] = beat.ServerTimeMs
	send(t, h, g, check)

	beat = decodeEvent(t, mustTick(t, h, g))
	if beat.RTTMs != 80 || beat.DriftMs != 260 {
		t.Errorf("HEARTBEAT = rtt %d drift %d, want 80 y 260", beat.RTTMs, beat.DriftMs)
	}
}

func mustTick(t *testing.T, h *Hub, c *Client) []byte {
	t.Helper()
	raw, err := h.Tick(c)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// O3: un solo recorrido por hub envía los latidos y cierra a los caídos.
func TestBeatAllSendsHeartbeatsAndClosesStale(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	a := connect(t, h, guest)
	next(t, a)
	b := connect(t, h, guestTwo)
	next(t, b)

	h.beatAll()
	nextOf(t, a, syncevent.Heartbeat)
	nextOf(t, b, syncevent.Heartbeat)

	e.clock.advance(HeartbeatInterval*MaxMissedChecks + time.Millisecond)
	send(t, h, a, cmd("c", syncevent.SyncCheck, 0)) // a sigue respondiendo
	h.beatAll()
	nextOf(t, a, syncevent.Heartbeat)
	select {
	case <-b.Done():
		if !errors.Is(b.Err(), ErrStale) {
			t.Errorf("causa = %v", b.Err())
		}
	case <-time.After(recvLimit):
		t.Fatal("el cliente sin respuesta debe cerrarse")
	}
	if a.Context().Err() != nil {
		t.Error("el cliente vivo no debe cerrarse")
	}
}

func TestRunDrivesHeartbeatsAndSweeps(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t).WithHeartbeat(10 * time.Millisecond).WithSweep(10 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.Run(ctx); close(done) }()
	g := connect(t, h, guest)
	nextOf(t, g, syncevent.Heartbeat)
	cancel()
	select {
	case <-done:
	case <-time.After(recvLimit):
		t.Fatal("Run debe terminar al cancelar el contexto")
	}
}

// F4: si la réplica del host muere sin despedirse, el barrido de otra
// réplica detecta que su presencia expiró y avisa una sola vez.
func TestSweepDetectsHostOnDeadReplica(t *testing.T) {
	e := newEnv(t)
	dead := e.newHub(t)
	alive := e.newHub(t)
	hc := connect(t, dead, host)
	next(t, hc)
	g := connect(t, alive, guest)
	next(t, g)
	e.waitSubscribers(t, 2)

	// La réplica "dead" deja de latir. Pasado el timeout, la viva lo detecta.
	e.clock.advance(6 * time.Second)
	send(t, alive, g, cmd("c", syncevent.SyncCheck, 0))
	alive.sweepAll(context.Background())
	if ev := nextOf(t, g, syncevent.HostStatus); ev.Online == nil || *ev.Online {
		t.Errorf("HOST_STATUS = %+v", ev)
	}
	alive.sweepAll(context.Background()) // sin cambios: no se repite
	expectNo(t, g, syncevent.HostStatus)
}

// F7: sin host durante el tiempo de gracia, el control pasa a un participante.
func TestControlHandoffAndReturn(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t).WithHandoff(time.Minute)
	hc, err := h.Connect(context.Background(), host)
	if err != nil {
		t.Fatal(err)
	}
	next(t, hc)
	g1 := connect(t, h, guest)    // guest:1
	g2 := connect(t, h, guestTwo) // guest:2
	next(t, g1)
	next(t, g2)
	h.Disconnect(hc)
	nextOf(t, g1, syncevent.HostStatus)

	// Antes del tiempo de gracia nadie recibe el control.
	e.clock.advance(30 * time.Second)
	keepAlive(t, h, g1, g2)
	h.sweepAll(context.Background())
	expectNo(t, g1, syncevent.Control)

	e.clock.advance(31 * time.Second)
	keepAlive(t, h, g1, g2)
	h.sweepAll(context.Background())
	if ev := nextOf(t, g1, syncevent.Control); ev.CanControl == nil || !*ev.CanControl {
		t.Errorf("guest:1 (menor sub) debe recibir el control: %+v", ev)
	}
	if ev := nextOf(t, g2, syncevent.Control); ev.CanControl == nil || *ev.CanControl {
		t.Errorf("guest:2 no tiene el control: %+v", ev)
	}
	send(t, h, g1, cmd("d-seek", syncevent.Seek, 5000))
	if ack := nextOf(t, g1, syncevent.Ack); ack.RefEventID != "d-seek" {
		t.Errorf("el delegado debe poder controlar: %+v", ack)
	}
	send(t, h, g2, cmd("x-seek", syncevent.Seek, 1))
	if ev := nextOf(t, g2, syncevent.Error); ev.Code != syncevent.CodeForbidden {
		t.Errorf("guest:2 = %+v", ev)
	}

	// El host vuelve: la delegación se anula.
	back := connect(t, h, host)
	if st := nextOf(t, back, syncevent.State); !*st.CanControl {
		t.Errorf("host STATE = %+v", st)
	}
	if ev := nextOf(t, g1, syncevent.Control); *ev.CanControl {
		t.Errorf("al volver el host el delegado pierde el control: %+v", ev)
	}
	send(t, h, g1, cmd("d-seek-2", syncevent.Seek, 9000))
	if ev := nextOf(t, g1, syncevent.Error); ev.Code != syncevent.CodeForbidden {
		t.Errorf("ex delegado = %+v", ev)
	}
}

func TestHandoffReassignsWhenDelegateLeaves(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t).WithHandoff(time.Minute)
	hc, _ := h.Connect(context.Background(), host)
	next(t, hc)
	g1, err := h.Connect(context.Background(), guest)
	if err != nil {
		t.Fatal(err)
	}
	next(t, g1)
	g2 := connect(t, h, guestTwo)
	next(t, g2)
	h.Disconnect(hc)
	e.clock.advance(2 * time.Minute)
	keepAlive(t, h, g1, g2)
	h.sweepAll(context.Background())
	nextOf(t, g2, syncevent.Control) // false: el control lo tiene guest:1

	h.Disconnect(g1)
	if ev := nextOf(t, g2, syncevent.Control); ev.CanControl == nil || !*ev.CanControl {
		t.Errorf("al irse el delegado, guest:2 recibe el control: %+v", ev)
	}
	// Un participante nuevo ve en su STATE que no tiene el control.
	g3 := connect(t, h, guestThree)
	if st := next(t, g3); st.CanControl == nil || *st.CanControl {
		t.Errorf("STATE de guest:3 = %+v", st)
	}
}

// Una sala a la que nunca entró el host no delega el control.
func TestNoHandoffWithoutHost(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t).WithHandoff(time.Minute)
	g := connect(t, h, guest)
	next(t, g)
	e.clock.advance(time.Hour)
	keepAlive(t, h, g)
	h.sweepAll(context.Background())
	expectNo(t, g, syncevent.Control)
}

func keepAlive(t *testing.T, h *Hub, cs ...*Client) {
	t.Helper()
	for _, c := range cs {
		send(t, h, c, cmd("alive", syncevent.SyncCheck, 0))
	}
}

// expectNo verifica que en un margen corto no llegue un mensaje del tipo dado.
func expectNo(t *testing.T, c *Client, typ syncevent.Type) {
	t.Helper()
	timeout := time.After(50 * time.Millisecond)
	for {
		select {
		case raw := <-c.Send():
			if ev := decodeEvent(t, raw); ev.Type == typ {
				t.Fatalf("no esperaba %s: %s", typ, raw)
			}
		case <-timeout:
			return
		}
	}
}

// F5: identity-api publica REVOKED; solo se cierra la conexión de ese jti
// y el mensaje nunca llega a los clientes.
func TestRevokedTokenIsDisconnected(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	revoked := guest
	revoked.JTI = "j-1"
	other := guestTwo
	other.JTI = "j-2"
	a := connect(t, h, revoked)
	next(t, a)
	b := connect(t, h, other)
	next(t, b)
	e.waitSubscribers(t, 1)

	payload := `{"event_id":"r1","type":"REVOKED","room_id":"room-1","jti":"j-1","position_ms":0,"version":0,` +
		`"occurred_at":"2026-10-10T18:00:00Z","received_at":"2026-10-10T18:00:00Z"}`
	e.mr.Publish(syncevent.ChannelKey(room), payload)

	select {
	case <-a.Done():
		if !errors.Is(a.Err(), ErrRevoked) {
			t.Errorf("causa = %v", a.Err())
		}
	case <-time.After(recvLimit):
		t.Fatal("la conexión revocada debe cerrarse")
	}
	expectNo(t, b, syncevent.Revoked)
	if b.Context().Err() != nil {
		t.Error("otro invitado no debe cerrarse")
	}
}
