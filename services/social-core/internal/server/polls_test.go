package server

import (
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/polls"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// fakeTimers sustituye time.AfterFunc: los timers solo corren cuando el
// test los dispara (sin sleeps).
type fakeTimers struct {
	mu      sync.Mutex
	pending []*fakeTimer
}

type fakeTimer struct {
	d       time.Duration
	f       func()
	stopped atomic.Bool
}

func (ft *fakeTimers) AfterFunc(d time.Duration, f func()) func() bool {
	t := &fakeTimer{d: d, f: f}
	ft.mu.Lock()
	ft.pending = append(ft.pending, t)
	ft.mu.Unlock()
	return func() bool { return !t.stopped.Swap(true) }
}

// take saca los timers vivos de duración d (esperando a que aparezcan).
func (ft *fakeTimers) take(t *testing.T, d time.Duration) []*fakeTimer {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ft.mu.Lock()
		var hit, rest []*fakeTimer
		for _, tm := range ft.pending {
			if tm.stopped.Load() {
				continue
			}
			if tm.d == d {
				hit = append(hit, tm)
			} else {
				rest = append(rest, tm)
			}
		}
		if len(hit) > 0 {
			ft.pending = rest
			ft.mu.Unlock()
			return hit
		}
		ft.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("no se agendó ningún timer de %v", d)
		}
		runtime.Gosched()
	}
}

// fire dispara los timers vivos de duración d.
func (ft *fakeTimers) fire(t *testing.T, d time.Duration) {
	t.Helper()
	for _, tm := range ft.take(t, d) {
		tm.f()
	}
}

// live cuenta timers vivos de duración d (sin esperar).
func (ft *fakeTimers) live(d time.Duration) int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	n := 0
	for _, tm := range ft.pending {
		if !tm.stopped.Load() && tm.d == d {
			n++
		}
	}
	return n
}

// testClock es un reloj inyectado que avanza a mano.
type testClock struct{ ms atomic.Int64 }

func newTestClock() *testClock {
	c := &testClock{}
	c.ms.Store(time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC).UnixMilli())
	return c
}
func (c *testClock) Now() time.Time              { return time.UnixMilli(c.ms.Load()).UTC() }
func (c *testClock) Advance(d time.Duration)     { c.ms.Add(d.Milliseconds()) }
func (c *testClock) UnixMilli() int64            { return c.ms.Load() }
func (c *testClock) after(d time.Duration) int64 { return c.ms.Load() + d.Milliseconds() }

// redisReplica arranca una réplica con Redis, reloj y timers inyectados.
func redisReplica(t *testing.T, mr *miniredis.Miniredis, secret string, clock *testClock, timers *fakeTimers) (string, *Deps) {
	t.Helper()
	env := map[string]string{"REDIS_URL": "redis://" + mr.Addr(), "JWT_SECRET": secret}
	deps := DefaultDeps(func(k string) string { return env[k] })
	deps.Now = clock.Now
	deps.AfterFunc = timers.AfterFunc
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	t.Cleanup(srv.Close)
	return "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1", deps
}

func createPoll(t *testing.T, c *websocket.Conn, dur int) {
	t.Helper()
	sendRaw(t, c, socialevent.PollCreate{
		EventID: "pc", Type: socialevent.TypePollCreate, RoomID: "r1",
		Question: " ¿Pizza o tacos? ", Options: []string{"Pizza", "Tacos"}, DurationS: dur,
	})
}

func counts(m map[string]any) []float64 {
	raw, _ := m["counts"].([]any)
	out := make([]float64, len(raw))
	for i, v := range raw {
		out[i], _ = v.(float64)
	}
	return out
}

func TestPollCreateBroadcastsAndRejectsSecond(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")

	// Un participante no puede crear ni cerrar.
	createPoll(t, g, 30)
	if m := nextOfType(t, colG, "error"); m["code"] != "FORBIDDEN" {
		t.Fatalf("participante crea = %v, want FORBIDDEN", m)
	}
	sendRaw(t, g, socialevent.PollClose{EventID: "x", Type: socialevent.TypePollClose, PollID: "p"})
	if m := nextOfType(t, colG, "error"); m["code"] != "FORBIDDEN" {
		t.Fatalf("participante cierra = %v, want FORBIDDEN", m)
	}

	createPoll(t, h, 30)
	var pollID string
	for name, col := range map[string]*collector{"host": colH, "guest": colG} {
		m := nextOfType(t, col, "poll_state")
		if m["question"] != "¿Pizza o tacos?" || m["closed"] != false || m["closes_at_ms"] != float64(clock.after(30*time.Second)) {
			t.Fatalf("%s poll_state = %v", name, m)
		}
		if c := counts(m); len(c) != 2 || c[0] != 0 || c[1] != 0 {
			t.Fatalf("%s counts = %v", name, m["counts"])
		}
		if _, has := m["my_vote"]; has {
			t.Fatalf("%s: el broadcast no lleva my_vote: %v", name, m)
		}
		pollID, _ = m["poll_id"].(string)
	}
	if pollID == "" {
		t.Fatal("poll_state sin poll_id")
	}
	createPoll(t, h, 30)
	if m := nextOfType(t, colH, "error"); m["code"] != "POLL_ACTIVE" {
		t.Fatalf("segunda encuesta = %v, want POLL_ACTIVE", m)
	}
	sendRaw(t, h, socialevent.PollCreate{EventID: "bad", Type: socialevent.TypePollCreate, Question: "q", Options: []string{"a"}, DurationS: 30})
	if m := nextOfType(t, colH, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("una sola opción = %v, want INVALID_PAYLOAD", m)
	}
	// El timer de cierre queda agendado a closes_at.
	if n := len(timers.take(t, 30*time.Second)); n != 1 {
		t.Fatalf("timers de cierre = %d, want 1", n)
	}
}

func TestPollVoteCoalescedAndMyVote(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	createPoll(t, h, 60)
	pollID := nextOfType(t, colG, "poll_state")["poll_id"].(string)
	nextOfType(t, colH, "poll_state")

	vote := func(c *websocket.Conn, id string, opt int) {
		sendRaw(t, c, socialevent.PollVote{EventID: id, Type: socialevent.TypePollVote, PollID: pollID, Option: &opt})
	}
	// Respuesta directa al votante con my_vote; nadie más la recibe.
	vote(g, "v1", 1)
	m := nextOfType(t, colG, "poll_state")
	if m["my_vote"] != float64(1) || counts(m)[1] != 1 {
		t.Fatalf("respuesta al voto = %v, want my_vote 1 y counts [0 1]", m)
	}
	vote(h, "v2", 0)
	if m := nextOfType(t, colH, "poll_state"); m["my_vote"] != float64(0) {
		t.Fatalf("respuesta al host = %v", m)
	}
	vote(g, "v3", 0) // cambia su voto
	if m := nextOfType(t, colG, "poll_state"); m["my_vote"] != float64(0) || counts(m)[0] != 2 || counts(m)[1] != 0 {
		t.Fatalf("voto cambiado = %v, want counts [2 0]", m)
	}
	// Tres votos en la ventana: un solo flush de 250 ms agendado.
	flushes := timers.take(t, PollFlushInterval)
	if len(flushes) != 1 {
		t.Fatalf("flushes agendados = %d, want 1 (coalescido)", len(flushes))
	}
	noneOfType(t, colH, "poll_state")
	flushes[0].f()
	for name, col := range map[string]*collector{"host": colH, "guest": colG} {
		m := nextOfType(t, col, "poll_state")
		if c := counts(m); c[0] != 2 || c[1] != 0 {
			t.Fatalf("%s flush = %v, want [2 0]", name, m)
		}
		if _, has := m["my_vote"]; has {
			t.Fatalf("%s: el broadcast no lleva my_vote", name)
		}
	}
	// Tras el flush, un voto nuevo agenda otro.
	vote(g, "v4", 1)
	nextOfType(t, colG, "poll_state")
	if n := len(timers.take(t, PollFlushInterval)); n != 1 {
		t.Fatalf("flush tras liberar = %d, want 1", n)
	}

	// Errores de voto.
	vote(g, "v5", 7)
	if m := nextOfType(t, colG, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("opción inexistente = %v", m)
	}
	sendRaw(t, g, socialevent.PollVote{EventID: "v6", Type: socialevent.TypePollVote, PollID: "otra", Option: new(int)})
	if m := nextOfType(t, colG, "error"); m["code"] != "POLL_NOT_FOUND" {
		t.Fatalf("otra encuesta = %v, want POLL_NOT_FOUND", m)
	}
	sendRaw(t, g, map[string]any{"type": "poll_vote", "event_id": "v7", "poll_id": pollID})
	if m := nextOfType(t, colG, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("sin opción = %v", m)
	}

	// Cierre manual del host: broadcast final y votos posteriores rechazados.
	sendRaw(t, h, socialevent.PollClose{EventID: "c1", Type: socialevent.TypePollClose, PollID: pollID})
	for name, col := range map[string]*collector{"host": colH, "guest": colG} {
		if m := nextOfType(t, col, "poll_state"); m["closed"] != true {
			t.Fatalf("%s cierre = %v, want closed", name, m)
		}
	}
	vote(g, "v8", 0)
	if m := nextOfType(t, colG, "error"); m["code"] != "POLL_CLOSED" {
		t.Fatalf("voto tras cierre = %v, want POLL_CLOSED", m)
	}
	sendRaw(t, h, socialevent.PollClose{EventID: "c2", Type: socialevent.TypePollClose, PollID: pollID})
	if m := nextOfType(t, colH, "error"); m["code"] != "POLL_CLOSED" {
		t.Fatalf("segundo cierre = %v, want POLL_CLOSED", m)
	}
	sendRaw(t, h, socialevent.PollClose{EventID: "c3", Type: socialevent.TypePollClose, PollID: "otra"})
	if m := nextOfType(t, colH, "error"); m["code"] != "POLL_NOT_FOUND" {
		t.Fatalf("cerrar otra = %v, want POLL_NOT_FOUND", m)
	}
	// El timer de cierre se canceló con el cierre manual.
	if n := timers.live(60 * time.Second); n != 0 {
		t.Fatalf("timers de cierre vivos = %d, want 0", n)
	}
}

func TestPollAutoClosesByTimeAcrossReplicasOnce(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock := newTestClock()
	timersA, timersB := &fakeTimers{}, &fakeTimers{}
	urlA, _ := redisReplica(t, mr, secret, clock, timersA)
	urlB, _ := redisReplica(t, mr, secret, clock, timersB)
	h, colH := joinCol(t, urlA, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	g, colG := joinCol(t, urlB, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	waitSubs(t, mr, chat.ChannelKey("r1"), 2)

	createPoll(t, h, 10)
	st := nextOfType(t, colG, "poll_state") // llegó a la otra réplica
	nextOfType(t, colH, "poll_state")
	pollID := st["poll_id"].(string)
	// Cada réplica agenda su propio timer (B al ver el poll_state remoto).
	tA, tB := timersA.take(t, 10*time.Second), timersB.take(t, 10*time.Second)

	// Un voto en B se ve en A tras el flush de B.
	one := 1
	sendRaw(t, g, socialevent.PollVote{EventID: "v1", Type: socialevent.TypePollVote, PollID: pollID, Option: &one})
	nextOfType(t, colG, "poll_state")
	timersB.fire(t, PollFlushInterval)
	if m := nextOfType(t, colH, "poll_state"); counts(m)[1] != 1 {
		t.Fatalf("A tras flush de B = %v, want [0 1]", m)
	}
	nextOfType(t, colG, "poll_state")

	// Vence: ambas réplicas disparan su timer; solo una cierra (HSETNX).
	clock.Advance(10 * time.Second)
	for _, tm := range append(tA, tB...) {
		tm.f()
	}
	for name, col := range map[string]*collector{"A": colH, "B": colG} {
		m := nextOfType(t, col, "poll_state")
		if m["closed"] != true || counts(m)[1] != 1 {
			t.Fatalf("%s cierre = %v", name, m)
		}
		noneOfType(t, col, "poll_state")
	}
	if v := mr.HGet(polls.PollKey("r1"), "closed"); v != "1" {
		t.Fatalf("closed en Redis = %q, want 1", v)
	}
}

func TestPollStateOnJoin(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	createPoll(t, h, 20)
	pollID := nextOfType(t, colH, "poll_state")["poll_id"].(string)
	opt := 1
	sendRaw(t, h, socialevent.PollVote{EventID: "v1", Type: socialevent.TypePollVote, PollID: pollID, Option: &opt})
	nextOfType(t, colH, "poll_state")

	// El host se reconecta: recibe la encuesta con su voto.
	h2, colH2 := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h2.Close(websocket.StatusNormalClosure, "")
	m := nextOfType(t, colH2, "poll_state")
	if m["poll_id"] != pollID || m["my_vote"] != float64(1) || counts(m)[1] != 1 || m["closed"] != false {
		t.Fatalf("poll_state al entrar = %v", m)
	}
	// Un invitado nuevo la recibe sin my_vote.
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	m = nextOfType(t, colG, "poll_state")
	if _, has := m["my_vote"]; has || m["poll_id"] != pollID {
		t.Fatalf("poll_state invitado = %v, want sin my_vote", m)
	}

	// Vencida sin que ninguna réplica la cerrara: al entrar se ve cerrada y
	// se cierra en Redis (idempotente) con broadcast a la sala.
	clock.Advance(21 * time.Second)
	g2, colG2 := joinCol(t, url, guestTokenAs(t, secret, "guest:caro", "Caro", "r1", exp0()))
	defer g2.Close(websocket.StatusNormalClosure, "")
	if m := nextOfType(t, colG2, "poll_state"); m["closed"] != true {
		t.Fatalf("encuesta vencida al entrar = %v, want closed", m)
	}
	if m := nextOfType(t, colG, "poll_state"); m["closed"] != true {
		t.Fatalf("broadcast de cierre = %v", m)
	}
}

func TestPollsUnavailableWithoutRedis(t *testing.T) {
	const secret = "s3cr3t"
	url := laserURL(t, testDeps(secret))
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	createPoll(t, h, 30)
	if m := nextOfType(t, colH, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("sin Redis = %v, want UNAVAILABLE", m)
	}
	one := 1
	sendRaw(t, h, socialevent.PollVote{EventID: "v", Type: socialevent.TypePollVote, PollID: "p", Option: &one})
	if m := nextOfType(t, colH, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("voto sin Redis = %v", m)
	}
	sendRaw(t, h, socialevent.PollClose{EventID: "c", Type: socialevent.TypePollClose, PollID: "p"})
	if m := nextOfType(t, colH, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("cierre sin Redis = %v", m)
	}
}

func TestAfterFuncDefault(t *testing.T) {
	d := &Deps{}
	done := make(chan struct{})
	stop := d.afterFunc(0, func() { close(done) })
	<-done
	_ = stop()
}
