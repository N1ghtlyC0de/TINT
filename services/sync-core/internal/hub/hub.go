// Package hub orquesta las salas del Canal Sync: registro de clientes,
// despacho de comandos, heartbeat/drift y presencia del host.
//
// Es independiente del transporte: la capa ws lee del socket y llama a
// Handle/Tick, y escribe lo que el cliente expone en Send().
//
// Flujo de un comando (HU-SYNC-02):
//
//	Handle → store.Apply (WATCH/MULTI + PUBLISH) → Redis Pub/Sub
//	       → bus de cada réplica → Deliver → canal Send() de cada cliente
//
// La réplica emisora no difunde localmente: todo pasa por Pub/Sub, así hay
// un único camino y un orden consistente en todas las réplicas.
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/drift"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/telemetry"
)

const (
	// SendBuffer es la cola de salida por cliente; si se llena, el cliente
	// es demasiado lento y se desconecta para no frenar a los demás.
	SendBuffer = 64
	// HeartbeatInterval es la frecuencia por defecto de HEARTBEAT (y de SYNC_CHECK).
	HeartbeatInterval = time.Second
	// MaxMissedChecks: latidos sin SYNC_CHECK antes de cerrar la conexión.
	MaxMissedChecks = 3
	// MaxMsgsPerSecond limita los mensajes entrantes por conexión.
	MaxMsgsPerSecond = 20
	// CacheTTL: cada cuánto se relee el estado de Redis aunque la caché
	// local (alimentada por el bus) esté al día. Red de seguridad por si se
	// perdiera un mensaje Pub/Sub durante una reconexión.
	CacheTTL = 5 * time.Second

	ioTimeout = 2 * time.Second
)

// StateStore persiste el Reloj Maestro y la presencia (ver package store).
type StateStore interface {
	Init(ctx context.Context, roomID, hostID string, nowMs int64) (master.State, error)
	Load(ctx context.Context, roomID string) (master.State, error)
	Apply(ctx context.Context, roomID, eventID string, cmd master.Command, receivedAtMs, rttMs int64, encode store.Encoder) (master.State, bool, error)
	Touch(ctx context.Context, roomID string) error
	HostSeen(ctx context.Context, roomID, connID string, nowMs int64) (int64, error)
	HostGone(ctx context.Context, roomID, connID string, nowMs int64) (int64, error)
	OnlineHosts(ctx context.Context, roomID string, nowMs int64) (int64, error)
}

// Bus distribuye mensajes de sala entre réplicas (ver package bus).
type Bus interface {
	Subscribe(ctx context.Context, roomID string) error
	Unsubscribe(ctx context.Context, roomID string) error
	Publish(ctx context.Context, roomID string, payload []byte) error
}

// Telemetry recibe las métricas de drift (ver package telemetry).
type Telemetry interface {
	EmitDrift(telemetry.DriftSample) bool
}

// Hub gestiona las salas con clientes conectados a esta réplica.
type Hub struct {
	store StateStore
	bus   Bus
	tel   Telemetry
	now   func() time.Time

	heartbeat time.Duration

	// mu protege rooms. Se mantiene durante Subscribe/Unsubscribe para que
	// un join y un leave concurrentes de la misma sala no se desordenen.
	mu    sync.Mutex
	rooms map[string]*roomEntry
}

// roomEntry son los clientes locales de una sala y la caché de su estado.
// Con la caché, los SYNC_CHECK (1/s por cliente) no consultan Redis: con
// 500 clientes serían 500 HGETALL/s compitiendo con los comandos del host.
type roomEntry struct {
	clients    map[*Client]struct{}
	state      master.State
	hasState   bool
	loadedAtMs int64
}

// New crea un Hub.
func New(s StateStore, b Bus, t Telemetry) *Hub {
	return &Hub{store: s, bus: b, tel: t, now: time.Now, heartbeat: HeartbeatInterval, rooms: make(map[string]*roomEntry)}
}

// WithHeartbeat cambia el intervalo de HEARTBEAT (por defecto 1 s).
func (h *Hub) WithHeartbeat(d time.Duration) *Hub {
	h.heartbeat = d
	return h
}

// HeartbeatInterval devuelve el intervalo de HEARTBEAT configurado.
func (h *Hub) HeartbeatInterval() time.Duration { return h.heartbeat }

// Connect registra una conexión autenticada, crea la sala si no existe y le
// encola de inmediato el STATE actual (HU-SYNC-01).
func (h *Hub) Connect(parent context.Context, claims auth.Claims) (*Client, error) {
	now := h.now()
	c := newClient(parent, claims, now.UnixMilli())
	room := claims.RoomID
	ctx, cancel := context.WithTimeout(parent, ioTimeout)
	defer cancel()

	// Suscribirse antes de leer el estado: un comando concurrente llegará
	// por el bus con version mayor y el cliente descarta lo obsoleto.
	if err := h.join(ctx, c); err != nil {
		return nil, err
	}
	hostID := ""
	if claims.Role == auth.RoleHost {
		hostID = claims.Sub
	}
	st, err := h.store.Init(ctx, room, hostID, now.UnixMilli())
	if err != nil {
		h.Disconnect(c)
		return nil, err
	}
	h.cache(room, st, now.UnixMilli())
	firstHost := false
	if claims.CanControl() {
		n, err := h.store.HostSeen(ctx, room, c.id, now.UnixMilli())
		if err != nil {
			h.Disconnect(c)
			return nil, err
		}
		firstHost = n == 1
	}
	online, err := h.store.OnlineHosts(ctx, room, now.UnixMilli())
	if err != nil {
		h.Disconnect(c)
		return nil, err
	}

	ev := stateEvent(syncevent.State, room, st, now)
	ev.Online = syncevent.Bool(online > 0)
	c.enqueue(mustJSON(ev))
	if firstHost {
		h.publishHostStatus(ctx, room, true)
	}
	return c, nil
}

// Disconnect da de baja al cliente. Es idempotente. La sala sobrevive con
// su TTL de gracia (REQ-07); si era el último host se avisa a los demás.
func (h *Hub) Disconnect(c *Client) {
	c.close(ErrClosed)
	if !h.leave(c) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
	defer cancel()
	room := c.claims.RoomID
	if c.claims.CanControl() {
		n, err := h.store.HostGone(ctx, room, c.id, h.now().UnixMilli())
		if err == nil && n == 0 {
			h.publishHostStatus(ctx, room, false)
		}
	}
	if err := h.store.Touch(ctx, room); err != nil {
		log.Printf("hub: touch sala %s: %v", room, err)
	}
}

// Deliver entrega un payload del bus a todos los clientes locales de la
// sala y, si es un comando, actualiza la caché del estado maestro.
func (h *Hub) Deliver(roomID string, payload []byte) {
	var ev syncevent.Event
	isCommand := json.Unmarshal(payload, &ev) == nil && ev.IsCommand()

	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[roomID]
	if !ok {
		return
	}
	if isCommand {
		r.update(master.State{
			Status: master.Status(ev.Status), PositionMs: ev.PositionMs, UpdatedAtMs: ev.UpdatedAtMs,
			Rate: ev.Rate, Version: ev.Version,
		}, h.now().UnixMilli())
	}
	for c := range r.clients {
		c.enqueue(payload)
	}
}

// Handle procesa un mensaje entrante. Solo debe llamarse desde la goroutine
// lectora del cliente (el rate limit no está protegido para concurrencia).
func (h *Hub) Handle(ctx context.Context, c *Client, raw []byte) {
	now := h.now()
	if !c.allow(now.UnixMilli()) {
		c.enqueue(mustJSON(errorEvent(c.claims.RoomID, "", syncevent.CodeRateLimited, now)))
		return
	}
	var ev syncevent.Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		c.enqueue(mustJSON(errorEvent(c.claims.RoomID, "", syncevent.CodeInvalid, now)))
		return
	}
	ev.ReceivedAt = now // el reloj del servidor siempre es el de recepción
	if err := ev.ValidateInbound(); err != nil || ev.RoomID != c.claims.RoomID {
		c.enqueue(mustJSON(errorEvent(c.claims.RoomID, ev.EventID, syncevent.CodeInvalid, now)))
		return
	}
	ctx, cancel := context.WithTimeout(ctx, ioTimeout)
	defer cancel()
	if ev.IsCommand() {
		h.handleCommand(ctx, c, ev, now)
		return
	}
	h.handleSyncCheck(ctx, c, ev, now)
}

func (h *Hub) handleCommand(ctx context.Context, c *Client, ev syncevent.Event, now time.Time) {
	room := c.claims.RoomID
	if !c.claims.CanControl() {
		c.enqueue(mustJSON(errorEvent(room, ev.EventID, syncevent.CodeForbidden, now)))
		return
	}
	encode := func(st master.State) ([]byte, error) {
		out := stateEvent(ev.Type, room, st, now)
		out.EventID = ev.EventID // mismo id en todos los clientes: idempotencia
		out.OccurredAt = ev.OccurredAt
		return json.Marshal(out)
	}
	cmd := master.Command{Type: ev.Type, PositionMs: ev.PositionMs}
	st, dup, err := h.store.Apply(ctx, room, ev.EventID, cmd, now.UnixMilli(), c.RTT(), encode)
	if err != nil {
		code := syncevent.CodeInternal
		if errors.Is(err, syncevent.ErrNegativePosition) {
			code = syncevent.CodeInvalid
		} else {
			log.Printf("hub: comando %s en sala %s: %v", ev.Type, room, err)
		}
		c.enqueue(mustJSON(errorEvent(room, ev.EventID, code, now)))
		return
	}
	ack := baseEvent(syncevent.Ack, room, now)
	ack.RefEventID = ev.EventID
	ack.Version = st.Version
	ack.Duplicate = dup
	c.enqueue(mustJSON(ack))
}

// handleSyncCheck mide el RTT con el reloj del servidor y corrige el drift
// si supera 500 ms (HU-SYNC-03).
func (h *Hub) handleSyncCheck(ctx context.Context, c *Client, ev syncevent.Event, now time.Time) {
	nowMs := now.UnixMilli()
	c.lastCheckMs.Store(nowMs)
	if ev.EchoServerTs > 0 {
		c.rttMs.Store(drift.UpdateRTT(c.rttMs.Load(), nowMs-ev.EchoServerTs))
	}
	room := c.claims.RoomID
	if c.claims.CanControl() {
		_, _ = h.store.HostSeen(ctx, room, c.id, nowMs) // latido de presencia
	}
	st, ok := h.fresh(room, nowMs)
	if !ok {
		loaded, err := h.store.Load(ctx, room)
		if err != nil {
			return // sin estado no hay referencia; el siguiente latido reintenta
		}
		st = h.cache(room, loaded, nowMs)
	}
	rtt := c.RTT()
	_, corr := drift.Check(st, ev.PositionMs, nowMs, rtt, h.now().UnixMilli())
	if corr == nil {
		return
	}
	out := baseEvent(syncevent.SyncCorrection, room, now)
	out.TargetMs = syncevent.Int64(corr.TargetMs)
	out.PositionMs = corr.TargetMs
	out.Strategy = string(corr.Strategy)
	out.DriftMs = corr.DriftMs
	out.Version = corr.Version
	c.enqueue(mustJSON(out))
	h.tel.EmitDrift(telemetry.DriftSample{
		RoomID: room, DriftMs: corr.DriftMs, RTTMs: rtt, Strategy: string(corr.Strategy),
		Role: string(c.claims.Role), OccurredAt: ev.OccurredAt, ReceivedAt: now,
	})
}

// Tick genera el siguiente HEARTBEAT del cliente o ErrStale si dejó de
// responder SYNC_CHECK durante MaxMissedChecks intervalos.
func (h *Hub) Tick(c *Client) ([]byte, error) {
	now := h.now()
	if now.UnixMilli()-c.lastCheckMs.Load() > (h.heartbeat * MaxMissedChecks).Milliseconds() {
		return nil, ErrStale
	}
	ev := baseEvent(syncevent.Heartbeat, c.claims.RoomID, now)
	ev.ServerTimeMs = now.UnixMilli()
	return mustJSON(ev), nil
}

func (h *Hub) join(ctx context.Context, c *Client) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := c.claims.RoomID
	r, ok := h.rooms[room]
	if !ok {
		if err := h.bus.Subscribe(ctx, room); err != nil {
			return err
		}
		r = &roomEntry{clients: make(map[*Client]struct{})}
		h.rooms[room] = r
	}
	r.clients[c] = struct{}{}
	return nil
}

// leave quita al cliente; devuelve false si ya no estaba registrado.
func (h *Hub) leave(c *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := c.claims.RoomID
	r, ok := h.rooms[room]
	if !ok {
		return false
	}
	if _, ok := r.clients[c]; !ok {
		return false
	}
	delete(r.clients, c)
	if len(r.clients) == 0 {
		delete(h.rooms, room)
		ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
		defer cancel()
		if err := h.bus.Unsubscribe(ctx, room); err != nil {
			log.Printf("hub: unsubscribe sala %s: %v", room, err)
		}
	}
	return true
}

// cache guarda st si es más nuevo que lo cacheado y devuelve el estado
// vigente de la sala (que puede ser uno más nuevo llegado por el bus).
func (h *Hub) cache(room string, st master.State, nowMs int64) master.State {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok {
		return st
	}
	r.update(st, nowMs)
	return r.state
}

// fresh devuelve el estado cacheado si existe y no superó CacheTTL.
func (h *Hub) fresh(room string, nowMs int64) (master.State, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok || !r.hasState || nowMs-r.loadedAtMs >= CacheTTL.Milliseconds() {
		return master.State{}, false
	}
	return r.state, true
}

// cached expone la caché para pruebas.
func (h *Hub) cached(room string) (master.State, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok {
		return master.State{}, false
	}
	return r.state, r.hasState
}

// update acepta el estado si no es más viejo que el cacheado: los mensajes
// pueden llegar desordenados y version es el orden total de la sala.
func (r *roomEntry) update(st master.State, nowMs int64) {
	if r.hasState && st.Version < r.state.Version {
		return
	}
	r.state, r.hasState, r.loadedAtMs = st, true, nowMs
}

func (h *Hub) publishHostStatus(ctx context.Context, room string, online bool) {
	ev := baseEvent(syncevent.HostStatus, room, h.now())
	ev.Online = syncevent.Bool(online)
	if err := h.bus.Publish(ctx, room, mustJSON(ev)); err != nil {
		log.Printf("hub: HOST_STATUS sala %s: %v", room, err)
	}
}

func baseEvent(typ syncevent.Type, room string, now time.Time) syncevent.Event {
	return syncevent.Event{EventID: uuid.NewString(), Type: typ, RoomID: room, OccurredAt: now, ReceivedAt: now}
}

func stateEvent(typ syncevent.Type, room string, st master.State, now time.Time) syncevent.Event {
	ev := baseEvent(typ, room, now)
	ev.PositionMs = st.PositionMs
	ev.Version = st.Version
	ev.Status = string(st.Status)
	ev.Rate = st.Rate
	ev.UpdatedAtMs = st.UpdatedAtMs
	ev.ServerTimeMs = now.UnixMilli()
	return ev
}

func errorEvent(room, ref, code string, now time.Time) syncevent.Event {
	ev := baseEvent(syncevent.Error, room, now)
	ev.RefEventID = ref
	ev.Code = code
	return ev
}

// mustJSON serializa eventos propios; Event no contiene tipos que puedan
// fallar al serializar, así que un error aquí es un bug de programación.
func mustJSON(ev syncevent.Event) []byte {
	raw, err := json.Marshal(ev)
	if err != nil {
		panic(err)
	}
	return raw
}
