package hub

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/bus"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/telemetry"
)

const room = "room-1"

var (
	t0        = time.Date(2026, 10, 10, 18, 0, 0, 0, time.UTC)
	host      = auth.Claims{Sub: "user-1", RoomID: room, Role: auth.RoleHost, Nick: "Ana"}
	cohost    = auth.Claims{Sub: "user-2", RoomID: room, Role: auth.RoleCohost}
	guest     = auth.Claims{Sub: "guest:1", RoomID: room, Role: auth.RoleParticipant, Nick: "Luis"}
	guestTwo  = auth.Claims{Sub: "guest:2", RoomID: room, Role: auth.RoleParticipant}
	recvLimit = 2 * time.Second
)

type fakeClock struct{ ms atomic.Int64 }

func (f *fakeClock) now() time.Time          { return time.UnixMilli(f.ms.Load()).UTC() }
func (f *fakeClock) advance(d time.Duration) { f.ms.Add(d.Milliseconds()) }

type fakeTelemetry struct {
	mu      sync.Mutex
	samples []telemetry.DriftSample
}

func (f *fakeTelemetry) EmitDrift(s telemetry.DriftSample) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.samples = append(f.samples, s)
	return true
}

func (f *fakeTelemetry) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.samples)
}

type env struct {
	mr    *miniredis.Miniredis
	clock *fakeClock
	tel   *fakeTelemetry
}

func newEnv(t *testing.T) *env {
	e := &env{mr: miniredis.RunT(t), clock: &fakeClock{}, tel: &fakeTelemetry{}}
	e.clock.ms.Store(t0.UnixMilli())
	return e
}

// newHub crea una "réplica" conectada al Redis compartido del entorno.
func (e *env) newHub(t *testing.T) *Hub {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: e.mr.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = rdb.Close() })
	b := bus.New(rdb)
	h := New(store.New(rdb, 12*time.Hour), b, e.tel)
	h.now = e.clock.now
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	b.Start(ctx, h.Deliver)
	t.Cleanup(func() { _ = b.Close() })
	return h
}

func (e *env) waitSubscribers(t *testing.T, n int) {
	t.Helper()
	ch := syncevent.ChannelKey(room)
	deadline := time.Now().Add(recvLimit)
	for time.Now().Before(deadline) {
		if e.mr.PubSubNumSub(ch)[ch] == n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("esperaba %d suscriptores, hay %d", n, e.mr.PubSubNumSub(ch)[ch])
}

func connect(t *testing.T, h *Hub, c auth.Claims) *Client {
	t.Helper()
	cl, err := h.Connect(context.Background(), c)
	if err != nil {
		t.Fatalf("Connect(%s): %v", c.Role, err)
	}
	t.Cleanup(func() { h.Disconnect(cl) })
	return cl
}

func next(t *testing.T, c *Client) syncevent.Event {
	t.Helper()
	select {
	case raw := <-c.Send():
		var ev syncevent.Event
		if err := json.Unmarshal(raw, &ev); err != nil {
			t.Fatalf("JSON inválido %s: %v", raw, err)
		}
		return ev
	case <-time.After(recvLimit):
		t.Fatal("no llegó ningún mensaje")
		return syncevent.Event{}
	}
}

func nextOf(t *testing.T, c *Client, typ syncevent.Type) syncevent.Event {
	t.Helper()
	for {
		if ev := next(t, c); ev.Type == typ {
			return ev
		}
	}
}

// expectSilence verifica que no lleguen mensajes. Ignora HOST_STATUS, que
// viaja por el bus de forma asíncrona tras la conexión de un host.
// collect lee mensajes hasta ver todos los tipos pedidos, sin importar el
// orden: el broadcast llega por el bus y puede adelantarse al ACK.
func collect(t *testing.T, c *Client, types ...syncevent.Type) map[syncevent.Type]syncevent.Event {
	t.Helper()
	want := map[syncevent.Type]bool{}
	for _, typ := range types {
		want[typ] = true
	}
	got := map[syncevent.Type]syncevent.Event{}
	for len(got) < len(want) {
		if ev := next(t, c); want[ev.Type] {
			got[ev.Type] = ev
		}
	}
	return got
}

func expectSilence(t *testing.T, c *Client) {
	t.Helper()
	timeout := time.After(50 * time.Millisecond)
	for {
		select {
		case raw := <-c.Send():
			var ev syncevent.Event
			_ = json.Unmarshal(raw, &ev)
			if ev.Type != syncevent.HostStatus {
				t.Fatalf("no esperaba mensajes, llegó %s", raw)
			}
		case <-timeout:
			return
		}
	}
}

func send(t *testing.T, h *Hub, c *Client, ev map[string]any) {
	t.Helper()
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	h.Handle(context.Background(), c, raw)
}

func cmd(id string, typ syncevent.Type, pos int64) map[string]any {
	return map[string]any{
		"event_id": id, "type": typ, "room_id": room, "position_ms": pos,
		"occurred_at": t0.Add(-time.Hour).Format(time.RFC3339Nano), // reloj de cliente atrasado: válido
	}
}

func TestConnectSendsInitialState(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)

	g := connect(t, h, guest)
	st := next(t, g)
	if st.Type != syncevent.State || st.Status != "paused" || st.PositionMs != 0 || st.Version != 0 ||
		st.ServerTimeMs != t0.UnixMilli() || st.Online == nil || *st.Online || st.RoomID != room || st.EventID == "" {
		t.Errorf("STATE inicial = %+v", st)
	}
	if err := st.Validate(); err != nil {
		t.Errorf("STATE debe cumplir el contrato: %v", err)
	}
}

func TestHostPresenceAndCommandsBroadcast(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)

	hc := connect(t, h, host)
	if st := next(t, hc); st.Online == nil || !*st.Online {
		t.Errorf("el host conectado debe verse online: %+v", st)
	}
	g := connect(t, h, guest)
	if st := next(t, g); st.Online == nil || !*st.Online {
		t.Errorf("el participante debe ver al host online: %+v", st)
	}
	e.waitSubscribers(t, 1) // una réplica, una suscripción para toda la sala

	e.clock.advance(time.Second)
	send(t, h, hc, cmd("e-play", syncevent.Play, 1500))

	got := collect(t, hc, syncevent.Ack, syncevent.Play)
	if ack := got[syncevent.Ack]; ack.RefEventID != "e-play" || ack.Version != 1 || ack.Duplicate {
		t.Errorf("ACK = %+v", ack)
	}
	for _, ev := range []syncevent.Event{got[syncevent.Play], nextOf(t, g, syncevent.Play)} {
		if ev.EventID != "e-play" || ev.Status != "playing" || ev.PositionMs != 1500 || ev.Version != 1 ||
			ev.UpdatedAtMs != t0.Add(time.Second).UnixMilli() || ev.Rate != 1 || ev.ReceivedAt.IsZero() {
			t.Errorf("broadcast PLAY = %+v", ev)
		}
	}
}

func TestCohostCanControl(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	c := connect(t, h, cohost)
	next(t, c)
	send(t, h, c, cmd("e1", syncevent.Seek, 9000))
	if ack := collect(t, c, syncevent.Ack)[syncevent.Ack]; ack.Version != 1 {
		t.Errorf("cohost ACK = %+v", ack)
	}
}

func TestParticipantCommandIsForbidden(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	send(t, h, g, cmd("e-evil", syncevent.Pause, 0))
	errEv := nextOf(t, g, syncevent.Error)
	if errEv.Code != syncevent.CodeForbidden || errEv.RefEventID != "e-evil" {
		t.Errorf("ERROR = %+v", errEv)
	}
	expectSilence(t, hc)
	if st, _ := h.store.Load(context.Background(), room); st.Version != 0 {
		t.Errorf("el estado maestro debe quedar intacto: %+v", st)
	}
}

func TestDuplicateCommandIsAckedOnce(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)

	send(t, h, hc, cmd("e1", syncevent.Seek, 5000))
	collect(t, hc, syncevent.Ack, syncevent.Seek)

	send(t, h, hc, cmd("e1", syncevent.Seek, 5000))
	ack := nextOf(t, hc, syncevent.Ack)
	if !ack.Duplicate || ack.Version != 1 {
		t.Errorf("ACK duplicado = %+v", ack)
	}
	expectSilence(t, hc)
}

func TestInvalidMessages(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)

	bad := cmd("e1", syncevent.Seek, -10)
	other := cmd("e2", syncevent.Play, 0)
	other["room_id"] = "otra-sala"
	chat := cmd("e3", "CHAT", 0)
	noID := cmd("", syncevent.Play, 0)

	for name, raw := range map[string][]byte{
		"json roto":         []byte("{nope"),
		"posición negativa": toJSON(t, bad),
		"otra sala":         toJSON(t, other),
		"chat":              toJSON(t, chat),
		"sin event_id":      toJSON(t, noID),
	} {
		h.Handle(context.Background(), hc, raw)
		if ev := nextOf(t, hc, syncevent.Error); ev.Code != syncevent.CodeInvalid {
			t.Errorf("%s: respuesta = %+v", name, ev)
		}
	}
}

func toJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSyncCheckCorrectsDriftAndEmitsTelemetry(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	send(t, h, hc, cmd("e-play", syncevent.Play, 0))
	nextOf(t, g, syncevent.Play)

	// A t0+10s el cliente sigue vivo (SYNC_CHECK alineado, sin echo).
	e.clock.advance(10 * time.Second)
	send(t, h, g, cmd("c0", syncevent.SyncCheck, 10_000))
	expectSilence(t, g)

	// El servidor late; el cliente responde 100 ms después (RTT=100).
	hb, err := h.Tick(g)
	if err != nil {
		t.Fatal(err)
	}
	var beat syncevent.Event
	if err := json.Unmarshal(hb, &beat); err != nil || beat.Type != syncevent.Heartbeat || beat.ServerTimeMs != t0.Add(10*time.Second).UnixMilli() {
		t.Fatalf("HEARTBEAT = %s (%v)", hb, err)
	}
	e.clock.advance(100 * time.Millisecond)

	check := cmd("c1", syncevent.SyncCheck, 9_000) // el maestro va en ~10050: drift ≈ -1050
	check["echo_server_ts"] = beat.ServerTimeMs
	send(t, h, g, check)

	corr := nextOf(t, g, syncevent.SyncCorrection)
	if corr.Strategy != "rate" || corr.DriftMs != -1050 || corr.TargetMs == nil || *corr.TargetMs != 10_150 || corr.Version != 1 {
		t.Errorf("SYNC_CORRECTION = %+v (target %v)", corr, corr.TargetMs)
	}
	if g.RTT() != 100 {
		t.Errorf("RTT = %d, want 100", g.RTT())
	}
	if e.tel.count() != 1 {
		t.Fatalf("telemetría emitida = %d, want 1", e.tel.count())
	}
	s := e.tel.samples[0]
	if s.RoomID != room || s.DriftMs != -1050 || s.RTTMs != 100 || s.Role != "participant" || s.Strategy != "rate" {
		t.Errorf("muestra = %+v", s)
	}

	// Alineado: ni corrección ni telemetría.
	aligned := cmd("c2", syncevent.SyncCheck, 10_050)
	send(t, h, g, aligned)
	expectSilence(t, g)
	if e.tel.count() != 1 {
		t.Error("un cliente alineado no genera telemetría")
	}
}

func TestTickDetectsStaleClient(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)

	e.clock.advance(HeartbeatInterval * MaxMissedChecks)
	if _, err := h.Tick(g); err != nil {
		t.Fatalf("aún dentro del margen: %v", err)
	}
	e.clock.advance(time.Millisecond)
	if _, err := h.Tick(g); !errors.Is(err, ErrStale) {
		t.Errorf("err = %v, want ErrStale", err)
	}
}

func TestSlowConsumerIsKicked(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest) // nunca lee su canal
	for i := 0; i <= SendBuffer; i++ {
		h.Deliver(room, []byte(`{}`))
	}
	select {
	case <-g.Done():
		if !errors.Is(g.Err(), ErrSlowConsumer) {
			t.Errorf("causa = %v", g.Err())
		}
	case <-time.After(recvLimit):
		t.Fatal("el cliente lento debe ser desconectado")
	}
}

func TestRateLimit(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)
	for i := 0; i < MaxMsgsPerSecond; i++ {
		send(t, h, g, cmd("c", syncevent.SyncCheck, 0))
	}
	send(t, h, g, cmd("c", syncevent.SyncCheck, 0))
	if ev := nextOf(t, g, syncevent.Error); ev.Code != syncevent.CodeRateLimited {
		t.Errorf("ERROR = %+v", ev)
	}
	// Nueva ventana de un segundo: vuelve a aceptar.
	e.clock.advance(time.Second)
	send(t, h, g, cmd("c", syncevent.SyncCheck, 0))
	expectSilence(t, g)
}

// REQ-07: la caída del host no destruye la sala; los demás se enteran.
func TestHostDisconnectKeepsRoomAlive(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc, err := h.Connect(context.Background(), host)
	if err != nil {
		t.Fatal(err)
	}
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)
	send(t, h, hc, cmd("e-play", syncevent.Play, 0))
	nextOf(t, g, syncevent.Play)

	h.Disconnect(hc)
	status := nextOf(t, g, syncevent.HostStatus)
	if status.Online == nil || *status.Online {
		t.Errorf("HOST_STATUS = %+v", status)
	}
	st, err := h.store.Load(context.Background(), room)
	if err != nil || st.Status != "playing" {
		t.Errorf("la sala debe seguir reproduciendo: %+v (%v)", st, err)
	}
	if ttl := e.mr.TTL(syncevent.StateKey(room)); ttl != 12*time.Hour {
		t.Errorf("TTL = %v", ttl)
	}

	// El host vuelve y recupera el control.
	back := connect(t, h, host)
	if st := next(t, back); st.Type != syncevent.State || st.Status != "playing" || !*st.Online {
		t.Errorf("STATE al reconectar = %+v", st)
	}
	if ev := nextOf(t, g, syncevent.HostStatus); !*ev.Online {
		t.Errorf("HOST_STATUS al volver = %+v", ev)
	}
}

func TestLastClientUnsubscribes(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	a, _ := h.Connect(context.Background(), guest)
	b, _ := h.Connect(context.Background(), guestTwo)
	e.waitSubscribers(t, 1)
	h.Disconnect(a)
	e.waitSubscribers(t, 1)
	h.Disconnect(b)
	e.waitSubscribers(t, 0)
	h.Disconnect(b) // idempotente
}

// SYNC-BE-05: host en la réplica A, participante en la réplica B.
func TestCrossReplicaBroadcast(t *testing.T) {
	e := newEnv(t)
	a := e.newHub(t)
	b := e.newHub(t)
	hc := connect(t, a, host)
	next(t, hc)
	g := connect(t, b, guest)
	next(t, g)
	e.waitSubscribers(t, 2)

	send(t, a, hc, cmd("e-seek", syncevent.Seek, 42_000))
	if ev := nextOf(t, g, syncevent.Seek); ev.PositionMs != 42_000 || ev.Version != 1 {
		t.Errorf("SEEK en réplica B = %+v", ev)
	}
}

func TestRedisDown(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	e.mr.Close()

	send(t, h, hc, cmd("e1", syncevent.Play, 0))
	if ev := nextOf(t, hc, syncevent.Error); ev.Code != syncevent.CodeInternal {
		t.Errorf("Redis caído: respuesta = %+v", ev)
	}
	send(t, h, hc, cmd("c1", syncevent.SyncCheck, 0))
	expectSilence(t, hc) // sin estado no se puede calcular drift: se ignora
	if _, err := h.Connect(context.Background(), guest); err == nil {
		t.Error("Connect con Redis caído debe fallar")
	}
}
