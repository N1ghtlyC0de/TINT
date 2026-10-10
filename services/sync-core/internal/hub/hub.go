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
//
// Run mantiene dos bucles por réplica (no por conexión): el de HEARTBEAT,
// que también cierra a los clientes que dejaron de responder, y el barrido
// de presencia, que publica HOST_STATUS aunque la réplica del host muera y
// delega el control si el host no vuelve (ver sweep).
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
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/codec"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/drift"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/metrics"
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
	// SweepInterval: cada cuánto se renueva la presencia y se evalúa el
	// estado del host y la delegación de control.
	SweepInterval = time.Second
	// HandoffAfter: tiempo sin host/cohost tras el cual un participante
	// recibe el control (CONTROL_HANDOFF_AFTER).
	HandoffAfter = 5 * time.Minute

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
	Beat(ctx context.Context, roomID string, hostConns, memberSubs []string, nowMs int64) error
	MemberGone(ctx context.Context, roomID, sub string) error
	Presence(ctx context.Context, roomID string, nowMs int64) (store.Presence, error)
	SetHostStatus(ctx context.Context, roomID string, online bool, nowMs int64) (bool, error)
	LiveMembers(ctx context.Context, roomID string, nowMs int64) ([]string, error)
	SwapDelegate(ctx context.Context, roomID, sub string) (string, error)
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

	heartbeat  time.Duration
	sweepEvery time.Duration
	handoff    time.Duration

	reg *metrics.Registry
	m   hubMetrics

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
	delegate   string // sub del participante con control delegado
}

// New crea un Hub.
func New(s StateStore, b Bus, t Telemetry) *Hub {
	h := &Hub{
		store: s, bus: b, tel: t, now: time.Now,
		heartbeat: HeartbeatInterval, sweepEvery: SweepInterval, handoff: HandoffAfter,
		rooms: make(map[string]*roomEntry), reg: metrics.NewRegistry(),
	}
	h.m = newHubMetrics(h.reg, h.roomCount)
	return h
}

// latencyBuckets (segundos) centrados en el objetivo de 100 ms.
var latencyBuckets = []float64{0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1}

// hubMetrics son las métricas operativas del hub (GET /metrics).
type hubMetrics struct {
	connections *metrics.Gauge
	commands    *metrics.CounterVec
	invalid     *metrics.Counter
	rateLimited *metrics.Counter
	disconnects *metrics.CounterVec
	corrections *metrics.CounterVec
	apply       *metrics.Histogram
	delivery    *metrics.Histogram
}

func newHubMetrics(r *metrics.Registry, rooms func() float64) hubMetrics {
	m := hubMetrics{
		connections: r.Gauge("sync_connections", "Conexiones WebSocket activas en esta réplica."),
		commands:    r.CounterVec("sync_commands_total", "Comandos de reproducción por resultado.", "result"),
		invalid:     r.Counter("sync_messages_invalid_total", "Mensajes entrantes inválidos."),
		rateLimited: r.Counter("sync_messages_rate_limited_total", "Mensajes rechazados por rate limit."),
		disconnects: r.CounterVec("sync_disconnects_total", "Desconexiones por motivo.", "reason"),
		corrections: r.CounterVec("sync_corrections_total", "Correcciones de drift por estrategia.", "strategy"),
		apply:       r.Histogram("sync_command_apply_seconds", "Duración de la escritura atómica de un comando en Redis.", latencyBuckets),
		delivery:    r.Histogram("sync_broadcast_delivery_seconds", "Recepción del comando → entrega del broadcast en esta réplica (Pub/Sub).", latencyBuckets),
	}
	r.GaugeFunc("sync_rooms", "Salas con clientes en esta réplica.", rooms)
	return m
}

// Registry devuelve el registro de métricas del hub, para exponerlo y
// añadirle las de otros componentes.
func (h *Hub) Registry() *metrics.Registry { return h.reg }

func (h *Hub) roomCount() float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return float64(len(h.rooms))
}

func disconnectReason(cause error) string {
	switch {
	case errors.Is(cause, ErrStale):
		return "stale"
	case errors.Is(cause, ErrSlowConsumer):
		return "slow"
	case errors.Is(cause, ErrRevoked):
		return "revoked"
	}
	return "normal"
}

// WithHeartbeat cambia el intervalo de HEARTBEAT (por defecto 1 s).
func (h *Hub) WithHeartbeat(d time.Duration) *Hub {
	h.heartbeat = d
	return h
}

// WithSweep cambia el intervalo del barrido de presencia (por defecto 1 s).
func (h *Hub) WithSweep(d time.Duration) *Hub {
	h.sweepEvery = d
	return h
}

// WithHandoff cambia el tiempo sin host tras el cual se delega el control.
func (h *Hub) WithHandoff(d time.Duration) *Hub {
	h.handoff = d
	return h
}

// HeartbeatInterval devuelve el intervalo de HEARTBEAT configurado.
func (h *Hub) HeartbeatInterval() time.Duration { return h.heartbeat }

// Run ejecuta los bucles de HEARTBEAT y de barrido hasta que ctx termine.
func (h *Hub) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); every(ctx, h.heartbeat, h.beatAll) }()
	go func() { defer wg.Done(); every(ctx, h.sweepEvery, func() { h.sweepAll(ctx) }) }()
	wg.Wait()
}

func every(ctx context.Context, d time.Duration, fn func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}

// beatAll envía el HEARTBEAT a cada cliente local y cierra a los que
// dejaron de responder. Un único temporizador por réplica en lugar de uno
// por conexión.
func (h *Hub) beatAll() {
	for _, c := range h.snapshotClients() {
		raw, err := h.Tick(c)
		if err != nil {
			c.close(err)
			continue
		}
		c.enqueue(raw)
	}
}

func (h *Hub) snapshotClients() []*Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []*Client
	for _, r := range h.rooms {
		for c := range r.clients {
			out = append(out, c)
		}
	}
	return out
}

// sweepAll renueva la presencia de los clientes locales y reevalúa cada sala.
func (h *Hub) sweepAll(ctx context.Context) {
	type roomBeat struct{ hosts, members []string }
	h.mu.Lock()
	beats := make(map[string]roomBeat, len(h.rooms))
	for id, r := range h.rooms {
		var b roomBeat
		seen := map[string]bool{}
		for c := range r.clients {
			switch {
			case c.ctx.Err() != nil:
			case c.claims.CanControl():
				b.hosts = append(b.hosts, c.id)
			case !seen[c.claims.Sub]:
				seen[c.claims.Sub] = true
				b.members = append(b.members, c.claims.Sub)
			}
		}
		beats[id] = b
	}
	h.mu.Unlock()

	for room, b := range beats {
		rctx, cancel := context.WithTimeout(ctx, ioTimeout)
		nowMs := h.now().UnixMilli()
		if err := h.store.Beat(rctx, room, b.hosts, b.members, nowMs); err != nil {
			log.Printf("hub: latido de presencia sala %s: %v", room, err)
		} else if _, err := h.sweep(rctx, room, nowMs); err != nil {
			log.Printf("hub: barrido sala %s: %v", room, err)
		}
		cancel()
	}
}

// presence es el resultado de evaluar una sala.
type presence struct {
	online   bool
	delegate string
}

// sweep reconcilia el estado del host y la delegación de una sala. Varias
// réplicas pueden ejecutarlo a la vez: el store solo informa transiciones
// y el delegado elegido es determinista, así que no hay avisos duplicados.
func (h *Hub) sweep(ctx context.Context, room string, nowMs int64) (presence, error) {
	p, err := h.store.Presence(ctx, room, nowMs)
	if err != nil {
		return presence{}, err
	}
	online := p.Online > 0
	changed, err := h.store.SetHostStatus(ctx, room, online, nowMs)
	if err != nil {
		return presence{}, err
	}
	if changed {
		h.publishHostStatus(ctx, room, online)
	}
	delegate := p.Delegate
	switch {
	case online && delegate != "":
		if err := h.swapDelegate(ctx, room, ""); err != nil {
			return presence{}, err
		}
		delegate = ""
	case !online && p.HostlessSinceMs > 0 && nowMs-p.HostlessSinceMs >= h.handoff.Milliseconds():
		members, err := h.store.LiveMembers(ctx, room, nowMs)
		if err != nil {
			return presence{}, err
		}
		candidate := ""
		if len(members) > 0 {
			candidate = members[0]
		}
		if candidate != delegate {
			if err := h.swapDelegate(ctx, room, candidate); err != nil {
				return presence{}, err
			}
			delegate = candidate
		}
	}
	h.applyDelegate(room, delegate)
	return presence{online: online, delegate: delegate}, nil
}

// swapDelegate fija el delegado y publica CONTROL si cambió.
func (h *Hub) swapDelegate(ctx context.Context, room, sub string) error {
	prev, err := h.store.SwapDelegate(ctx, room, sub)
	if err != nil || prev == sub {
		return err
	}
	ev := baseEvent(syncevent.Control, room, h.now())
	ev.Holder = sub
	if err := h.bus.Publish(ctx, room, mustJSON(ev)); err != nil {
		log.Printf("hub: CONTROL sala %s: %v", room, err)
	}
	return nil
}

// applyDelegate actualiza el delegado local y avisa a los participantes
// locales si cambió (los host/cohost siempre tienen el control).
func (h *Hub) applyDelegate(room, holder string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok || r.delegate == holder {
		return
	}
	r.delegate = holder
	now := h.now()
	for c := range r.clients {
		if c.claims.CanControl() {
			continue
		}
		ev := baseEvent(syncevent.Control, room, now)
		ev.CanControl = syncevent.Bool(c.claims.Sub == holder)
		c.enqueueEvent(ev)
	}
}

// revoke cierra las conexiones locales del token revocado.
func (h *Hub) revoke(room, jti string) {
	if jti == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok {
		return
	}
	for c := range r.clients {
		if c.claims.JTI == jti {
			c.close(ErrRevoked)
		}
	}
}

// canControl indica si el cliente puede emitir comandos ahora mismo.
func (h *Hub) canControl(c *Client) bool {
	if c.claims.CanControl() {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[c.claims.RoomID]
	return ok && r.delegate != "" && r.delegate == c.claims.Sub
}

// Connect registra una conexión autenticada, crea la sala si no existe y le
// encola de inmediato el STATE actual (HU-SYNC-01).
func (h *Hub) Connect(parent context.Context, claims auth.Claims, opts ...ConnOption) (*Client, error) {
	now := h.now()
	c := newClient(parent, claims, now.UnixMilli())
	for _, opt := range opts {
		opt(c)
	}
	room := claims.RoomID
	ctx, cancel := context.WithTimeout(parent, ioTimeout)
	defer cancel()

	// Suscribirse antes de leer el estado: un comando concurrente llegará
	// por el bus con version mayor y el cliente descarta lo obsoleto.
	if err := h.join(ctx, c); err != nil {
		return nil, err
	}
	h.m.connections.Inc()
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
	nowMs := now.UnixMilli()
	if claims.CanControl() {
		_, err = h.store.HostSeen(ctx, room, c.id, nowMs)
	} else {
		err = h.store.Beat(ctx, room, nil, []string{claims.Sub}, nowMs)
	}
	if err != nil {
		h.Disconnect(c)
		return nil, err
	}
	p, err := h.store.Presence(ctx, room, nowMs)
	if err != nil {
		h.Disconnect(c)
		return nil, err
	}

	// El STATE va primero (HU-SYNC-01); el barrido puede publicar
	// HOST_STATUS/CONTROL, que llegan después por el bus.
	ev := stateEvent(syncevent.State, room, st, now)
	ev.Online = syncevent.Bool(p.Online > 0)
	ev.CanControl = syncevent.Bool(claims.CanControl() || (p.Delegate != "" && p.Delegate == claims.Sub))
	c.enqueueEvent(ev)
	if _, err := h.sweep(ctx, room, nowMs); err != nil {
		log.Printf("hub: barrido sala %s: %v", room, err)
	}
	return c, nil
}

// Disconnect da de baja al cliente. Es idempotente. La sala sobrevive con
// su TTL de gracia (REQ-07); si era el último host se avisa a los demás.
func (h *Hub) Disconnect(c *Client) {
	cause := c.Err()
	c.close(ErrClosed)
	left, ok := h.leave(c)
	if !ok {
		return
	}
	h.m.connections.Dec()
	h.m.disconnects.With(disconnectReason(cause)).Inc()
	ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
	defer cancel()
	room := c.claims.RoomID
	nowMs := h.now().UnixMilli()
	reevaluate := false
	if c.claims.CanControl() {
		if _, err := h.store.HostGone(ctx, room, c.id, nowMs); err == nil {
			reevaluate = true
		}
	} else if !left.sameSub {
		if err := h.store.MemberGone(ctx, room, c.claims.Sub); err == nil {
			reevaluate = left.delegate == c.claims.Sub // se fue el delegado: reasignar
		}
	}
	if reevaluate {
		if _, err := h.sweep(ctx, room, nowMs); err != nil {
			log.Printf("hub: barrido sala %s: %v", room, err)
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
	parsed := json.Unmarshal(payload, &ev) == nil
	if parsed {
		switch ev.Type {
		case syncevent.Control:
			h.applyDelegate(roomID, ev.Holder) // cada cliente recibe su propio CONTROL
			return
		case syncevent.Revoked:
			h.revoke(roomID, ev.JTI) // solo entre réplicas: nunca llega a los clientes
			return
		}
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[roomID]
	if !ok {
		return
	}
	if ev.IsCommand() {
		if d := h.now().Sub(ev.ReceivedAt); d >= 0 {
			h.m.delivery.Observe(d.Seconds())
		}
		r.update(master.State{
			Status: master.Status(ev.Status), PositionMs: ev.PositionMs, UpdatedAtMs: ev.UpdatedAtMs,
			Rate: ev.Rate, Version: ev.Version, MediaID: ev.MediaID,
		}, h.now().UnixMilli())
	}
	// El bus siempre viaja en JSON; para los clientes MessagePack se
	// transcodifica una sola vez y los bytes se comparten entre todos.
	var packed []byte
	for c := range r.clients {
		if c.codec == codec.JSON {
			c.enqueue(payload)
			continue
		}
		if packed == nil && parsed {
			packed, _ = c.codec.Encode(ev)
		}
		if packed != nil {
			c.enqueue(packed)
		}
	}
}

// Handle procesa un mensaje entrante. Solo debe llamarse desde la goroutine
// lectora del cliente (el rate limit no está protegido para concurrencia).
func (h *Hub) Handle(ctx context.Context, c *Client, raw []byte) {
	now := h.now()
	if !c.allow(now.UnixMilli()) {
		h.m.rateLimited.Inc()
		c.enqueueEvent(errorEvent(c.claims.RoomID, "", syncevent.CodeRateLimited, now))
		return
	}
	var ev syncevent.Event
	if err := c.codec.Decode(raw, &ev); err != nil {
		h.m.invalid.Inc()
		c.enqueueEvent(errorEvent(c.claims.RoomID, "", syncevent.CodeInvalid, now))
		return
	}
	ev.ReceivedAt = now // el reloj del servidor siempre es el de recepción
	if err := ev.ValidateInbound(); err != nil || ev.RoomID != c.claims.RoomID {
		h.m.invalid.Inc()
		c.enqueueEvent(errorEvent(c.claims.RoomID, ev.EventID, syncevent.CodeInvalid, now))
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
	if !h.canControl(c) {
		h.m.commands.With("forbidden").Inc()
		c.enqueueEvent(errorEvent(room, ev.EventID, syncevent.CodeForbidden, now))
		return
	}
	encode := func(st master.State) ([]byte, error) {
		out := stateEvent(ev.Type, room, st, now)
		out.EventID = ev.EventID // mismo id en todos los clientes: idempotencia
		out.OccurredAt = ev.OccurredAt
		return json.Marshal(out)
	}
	cmd := master.Command{Type: ev.Type, PositionMs: ev.PositionMs, Rate: ev.Rate, MediaID: ev.MediaID}
	started := time.Now()
	st, dup, err := h.store.Apply(ctx, room, ev.EventID, cmd, now.UnixMilli(), c.RTT(), encode)
	h.m.apply.Observe(time.Since(started).Seconds())
	if err != nil {
		code, result := syncevent.CodeInternal, "error"
		if errors.Is(err, syncevent.ErrNegativePosition) || errors.Is(err, syncevent.ErrInvalidRate) || errors.Is(err, syncevent.ErrInvalidMedia) {
			code, result = syncevent.CodeInvalid, "invalid"
		} else {
			log.Printf("hub: comando %s en sala %s: %v", ev.Type, room, err)
		}
		h.m.commands.With(result).Inc()
		c.enqueueEvent(errorEvent(room, ev.EventID, code, now))
		return
	}
	if dup {
		h.m.commands.With("duplicate").Inc()
	} else {
		h.m.commands.With("ok").Inc()
	}
	ack := baseEvent(syncevent.Ack, room, now)
	ack.RefEventID = ev.EventID
	ack.Version = st.Version
	ack.Duplicate = dup
	c.enqueueEvent(ack)
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
	st, ok := h.fresh(room, nowMs)
	if !ok {
		loaded, err := h.store.Load(ctx, room)
		if err != nil {
			return // sin estado no hay referencia; el siguiente latido reintenta
		}
		st = h.cache(room, loaded, nowMs)
	}
	rtt := c.RTT()
	driftMs, corr := drift.Check(st, ev.PositionMs, nowMs, rtt, h.now().UnixMilli())
	c.lastDriftMs.Store(driftMs)
	if corr == nil {
		return
	}
	h.m.corrections.With(string(corr.Strategy)).Inc()
	out := baseEvent(syncevent.SyncCorrection, room, now)
	out.TargetMs = syncevent.Int64(corr.TargetMs)
	out.PositionMs = corr.TargetMs
	out.Strategy = string(corr.Strategy)
	out.DriftMs = corr.DriftMs
	out.Version = corr.Version
	c.enqueueEvent(out)
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
	ev.RTTMs = c.RTT()
	ev.DriftMs = c.lastDriftMs.Load()
	return c.codec.Encode(ev)
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

// leftInfo describe la sala que deja un cliente.
type leftInfo struct {
	delegate string // delegado vigente al salir
	sameSub  bool   // queda otra conexión local con el mismo sub
}

// leave quita al cliente; ok es false si ya no estaba registrado.
func (h *Hub) leave(c *Client) (leftInfo, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := c.claims.RoomID
	r, ok := h.rooms[room]
	if !ok {
		return leftInfo{}, false
	}
	if _, ok := r.clients[c]; !ok {
		return leftInfo{}, false
	}
	delete(r.clients, c)
	info := leftInfo{delegate: r.delegate}
	for other := range r.clients {
		if other.claims.Sub == c.claims.Sub {
			info.sameSub = true
			break
		}
	}
	if len(r.clients) == 0 {
		delete(h.rooms, room)
		ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
		defer cancel()
		if err := h.bus.Unsubscribe(ctx, room); err != nil {
			log.Printf("hub: unsubscribe sala %s: %v", room, err)
		}
	}
	return info, true
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
	ev.MediaID = st.MediaID
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
