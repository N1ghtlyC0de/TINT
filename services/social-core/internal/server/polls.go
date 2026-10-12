// Package server — encuestas en vivo (multirréplica vía Redis y Pub/Sub).
//
// El estado vive en Redis (internal/polls); cada réplica con clientes de la
// sala agenda su propio timer de cierre a closes_at_ms (reloj y timers
// inyectados) y el cierre es idempotente (HSETNX closed): solo la réplica
// que lo gana emite el poll_state final. Los votos se coalescen: como mucho
// un broadcast por PollFlushInterval y sala, coordinado con una marca en
// Redis para que varias réplicas no emitan cada una el suyo.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/polls"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// PollFlushInterval es la ventana de coalescencia de votos por sala.
const PollFlushInterval = 250 * time.Millisecond

// PollActionsPerSecond limita votos y peticiones por usuario.
const PollActionsPerSecond = 10

// pollOpTimeout acota cada operación Redis lanzada desde un timer.
const pollOpTimeout = 2 * time.Second

// pollTimer es el timer de cierre de la encuesta actual de una sala.
type pollTimer struct {
	pollID string
	stop   func() bool
}

func (d *Deps) afterFunc(dur time.Duration, f func()) func() bool {
	if d.AfterFunc != nil {
		return d.AfterFunc(dur, f)
	}
	return time.AfterFunc(dur, f).Stop
}

func pollErrorCode(err error) string {
	switch {
	case errors.Is(err, polls.ErrActive):
		return "POLL_ACTIVE"
	case errors.Is(err, polls.ErrNotFound):
		return "POLL_NOT_FOUND"
	case errors.Is(err, polls.ErrClosed):
		return "POLL_CLOSED"
	case errors.Is(err, polls.ErrOption):
		return "INVALID_PAYLOAD"
	}
	return "UNAVAILABLE"
}

func (d *Deps) handlePollCreate(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte) {
	var in socialevent.PollCreate
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if d.Polls == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	question, options := in.Normalized()
	now := d.now().UnixMilli()
	p := polls.Poll{
		ID: d.newID(), Question: question, Options: options,
		ClosesAtMS: now + int64(in.DurationS)*1000,
	}
	if err := d.Polls.Create(ctx, roomID, p, now); err != nil {
		writeError(ctx, c, pollErrorCode(err), in.EventID)
		return
	}
	if d.OnPollCreated != nil {
		d.OnPollCreated(ctx, roomID)
	}
	st := d.pollState(roomID, p, make([]int64, len(options)), now)
	d.observePoll(roomID, st.PollID, st.ClosesAtMS, st.Closed)
	d.emitRoom(ctx, roomID, st.EventID, st)
}

func (d *Deps) handlePollVote(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte, limiter *reactions.Limiter) {
	var in socialevent.PollVote
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if d.Polls == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if !limiter.Allow(claims.Subject, d.now()) {
		writeError(ctx, c, "RATE_LIMITED", in.EventID)
		return
	}
	if err := d.Polls.Vote(ctx, roomID, in.PollID, claims.Subject, *in.Option, d.now().UnixMilli()); err != nil {
		writeError(ctx, c, pollErrorCode(err), in.EventID)
		return
	}
	// Respuesta inmediata solo al votante, con su my_vote.
	if st, _, ok := d.loadPollState(ctx, roomID, claims.Subject); ok {
		if raw, err := json.Marshal(st); err == nil {
			_ = writeMsg(ctx, c, raw, d.writeTimeout())
		}
	}
	d.scheduleFlush(ctx, roomID)
}

func (d *Deps) handlePollClose(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte) {
	var in socialevent.PollClose
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if d.Polls == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	closed, err := d.Polls.Close(ctx, roomID, in.PollID)
	if err != nil {
		writeError(ctx, c, pollErrorCode(err), in.EventID)
		return
	}
	if !closed {
		writeError(ctx, c, "POLL_CLOSED", in.EventID)
		return
	}
	d.broadcastPoll(ctx, roomID)
}

// pollState arma el poll_state de p; closed también si ya venció.
func (d *Deps) pollState(roomID string, p polls.Poll, counts []int64, nowMS int64) socialevent.PollState {
	return socialevent.PollState{
		EventID: d.newID(), Type: socialevent.TypePollState, RoomID: roomID,
		PollID: p.ID, Question: p.Question, Options: p.Options, Counts: counts,
		ClosesAtMS: p.ClosesAtMS, Closed: p.Closed || nowMS >= p.ClosesAtMS,
	}
}

// loadPollState lee la encuesta actual con sus conteos y, si userID no es
// vacío, el voto de ese usuario. ok=false si no hay encuesta o Redis falla.
func (d *Deps) loadPollState(ctx context.Context, roomID, userID string) (socialevent.PollState, polls.Poll, bool) {
	p, ok, err := d.Polls.Current(ctx, roomID)
	if err != nil || !ok {
		return socialevent.PollState{}, polls.Poll{}, false
	}
	counts, err := d.Polls.Counts(ctx, roomID, p.ID, len(p.Options))
	if err != nil {
		return socialevent.PollState{}, polls.Poll{}, false
	}
	st := d.pollState(roomID, p, counts, d.now().UnixMilli())
	if userID != "" {
		if v, voted, err := d.Polls.VoteOf(ctx, roomID, p.ID, userID); err == nil && voted {
			st.MyVote = &v
		}
	}
	return st, p, true
}

// broadcastPoll emite el estado actual (sin my_vote) a toda la sala.
func (d *Deps) broadcastPoll(ctx context.Context, roomID string) {
	st, _, ok := d.loadPollState(ctx, roomID, "")
	if !ok {
		return
	}
	d.observePoll(roomID, st.PollID, st.ClosesAtMS, st.Closed)
	d.emitRoom(ctx, roomID, st.EventID, st)
}

// sendPollOnJoin envía al cliente que entra la encuesta actual con su voto.
// Si venció sin que nadie la cerrara (p. ej. todas las réplicas se
// reiniciaron), la cierra ahora; si sigue abierta, asegura el timer local.
func (d *Deps) sendPollOnJoin(ctx context.Context, c *websocket.Conn, roomID, userID string) {
	if d.Polls == nil {
		return
	}
	st, p, ok := d.loadPollState(ctx, roomID, userID)
	if !ok {
		return
	}
	if raw, err := json.Marshal(st); err == nil {
		_ = writeMsg(ctx, c, raw, d.writeTimeout())
	}
	switch {
	case !st.Closed:
		d.observePoll(roomID, p.ID, p.ClosesAtMS, false)
	case !p.Closed:
		go d.expirePoll(roomID, p.ID)
	}
}

// observePoll mantiene un timer de cierre por sala y réplica para la
// encuesta vigente (local o vista por el relay).
func (d *Deps) observePoll(roomID, pollID string, closesAtMS int64, closed bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pollTimers == nil {
		d.pollTimers = make(map[string]*pollTimer)
	}
	cur := d.pollTimers[roomID]
	if closed {
		if cur != nil && cur.pollID == pollID {
			cur.stop()
			delete(d.pollTimers, roomID)
		}
		return
	}
	if cur != nil {
		if cur.pollID == pollID {
			return // ya agendado
		}
		cur.stop() // la reemplazó una encuesta nueva
	}
	delay := time.Duration(closesAtMS-d.now().UnixMilli()) * time.Millisecond
	if delay < 0 {
		delay = 0
	}
	stop := d.afterFunc(delay, func() { d.expirePoll(roomID, pollID) })
	d.pollTimers[roomID] = &pollTimer{pollID: pollID, stop: stop}
}

// expirePoll cierra por tiempo; solo quien gana el HSETNX emite el final.
func (d *Deps) expirePoll(roomID, pollID string) {
	d.mu.Lock()
	if cur := d.pollTimers[roomID]; cur != nil && cur.pollID == pollID {
		delete(d.pollTimers, roomID)
	}
	d.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), pollOpTimeout)
	defer cancel()
	if closed, err := d.Polls.Close(ctx, roomID, pollID); err == nil && closed {
		d.broadcastPoll(ctx, roomID)
	}
}

// scheduleFlush agenda el broadcast coalescido si nadie lo tiene agendado.
func (d *Deps) scheduleFlush(ctx context.Context, roomID string) {
	if ok, err := d.Polls.TryFlush(ctx, roomID); err != nil || !ok {
		return
	}
	d.afterFunc(PollFlushInterval, func() { d.flushPoll(roomID) })
}

// flushPoll suelta la marca y luego lee: un voto posterior a la lectura
// vuelve a agendar, así ningún voto queda sin emitir.
func (d *Deps) flushPoll(roomID string) {
	ctx, cancel := context.WithTimeout(context.Background(), pollOpTimeout)
	defer cancel()
	_ = d.Polls.ReleaseFlush(ctx, roomID)
	d.broadcastPoll(ctx, roomID)
}

// observeRemotePoll agenda el timer al ver un poll_state de otra réplica.
func (d *Deps) observeRemotePoll(roomID string, payload []byte) {
	var st socialevent.PollState
	if json.Unmarshal(payload, &st) != nil || st.PollID == "" || d.Polls == nil {
		return
	}
	d.observePoll(roomID, st.PollID, st.ClosesAtMS, st.Closed)
}
