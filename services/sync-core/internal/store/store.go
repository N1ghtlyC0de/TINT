// Package store persiste el Reloj Maestro de cada sala en Redis
// (room:{id}:sync_state) y la presencia de hosts entre réplicas.
//
// Los comandos usan compare-and-set optimista: se lee el estado (una ida y
// vuelta), se calcula el siguiente con master.Apply (única fuente de verdad)
// y un script Lua lo escribe y publica solo si la version no cambió (otra
// ida y vuelta, atómica en Redis). Si otra réplica escribió en medio, se
// reintenta con espera aleatoria, así ningún comando se pierde.
//
// Dentro de una réplica los comandos de una misma sala se serializan con un
// candado local: así los conflictos solo pueden venir de otras réplicas.
// Con WATCH/MULTI, 16 escritores concurrentes agotaban los reintentos.
package store

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"math/rand/v2"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

const (
	// dedupeWindow es cuánto se recuerda un event_id para descartar reintentos.
	dedupeWindow = time.Minute
	// PresenceTimeout: un host que no late en este tiempo se considera fuera
	// (cubre réplicas que mueren sin ejecutar HostGone).
	PresenceTimeout = 5 * time.Second
	maxTxRetries    = 50
	// lockStripes: candados locales repartidos por hash de sala (memoria
	// acotada sin importar cuántas salas haya).
	lockStripes = 256
	// maxBackoff limita la espera aleatoria tras un conflicto entre réplicas.
	maxBackoff = 4 * time.Millisecond
)

// casScript aplica el estado calculado en Go solo si nadie escribió antes.
// KEYS: estado, evt. ARGV: version esperada, dedupe ms, ttl ms, canal,
// payload, pares campo/valor del estado.
var casScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[2]) == 1 then return 'DUP' end
if redis.call('HGET', KEYS[1], 'version') ~= ARGV[1] then return 'CONFLICT' end
redis.call('SET', KEYS[2], 1, 'PX', ARGV[2])
redis.call('HSET', KEYS[1], unpack(ARGV, 6))
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PUBLISH', ARGV[4], ARGV[5])
return 'OK'
`)

var (
	ErrNotFound = errors.New("la sala no tiene estado de sincronización")
	errConflict = errors.New("conflicto de escritura concurrente")
)

// Encoder construye el payload que se publica a todas las réplicas.
type Encoder func(master.State) ([]byte, error)

// Store es el repositorio Redis del dominio de sincronización.
type Store struct {
	rdb   redis.UniversalClient
	ttl   time.Duration
	locks [lockStripes]sync.Mutex
}

// New crea un Store; ttl es el periodo de gracia de la sala (REQ-07).
func New(rdb redis.UniversalClient, ttl time.Duration) *Store {
	return &Store{rdb: rdb, ttl: ttl}
}

// Init crea el estado de la sala si no existe (pausada en 0), registra al
// host si hostID no está vacío y refresca el TTL. Nunca pisa un estado vivo.
func (s *Store) Init(ctx context.Context, roomID, hostID string, nowMs int64) (master.State, error) {
	key := syncevent.StateKey(roomID)
	init := master.Initial(hostID, nowMs)
	_, err := s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		for field, value := range fields(init) {
			if field != "host_id" {
				p.HSetNX(ctx, key, field, value)
			}
		}
		if hostID != "" {
			p.HSet(ctx, key, "host_id", hostID)
		}
		p.PExpire(ctx, key, s.ttl)
		return nil
	})
	if err != nil {
		return master.State{}, fmt.Errorf("init sala %s: %w", roomID, err)
	}
	return s.Load(ctx, roomID)
}

// Load lee el estado actual de la sala.
func (s *Store) Load(ctx context.Context, roomID string) (master.State, error) {
	return load(ctx, s.rdb, roomID)
}

// Apply aplica cmd de forma atómica. Devuelve el estado resultante y si el
// event_id ya se había procesado (en cuyo caso el estado no cambia).
func (s *Store) Apply(ctx context.Context, roomID, eventID string, cmd master.Command, receivedAtMs, rttMs int64, encode Encoder) (master.State, bool, error) {
	mu := s.lockFor(roomID)
	mu.Lock()
	defer mu.Unlock()

	stateKey := syncevent.StateKey(roomID)
	evtKey := syncevent.EventKey(roomID, eventID)
	for i := 0; i < maxTxRetries; i++ {
		var seen *redis.IntCmd
		var raw *redis.MapStringStringCmd
		if _, err := s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
			seen = p.Exists(ctx, evtKey)
			raw = p.HGetAll(ctx, stateKey)
			return nil
		}); err != nil {
			return master.State{}, false, err
		}
		cur, err := decode(raw.Val())
		if err != nil {
			return master.State{}, false, err
		}
		if seen.Val() > 0 {
			return cur, true, nil
		}
		next, err := cur.Apply(cmd, receivedAtMs, rttMs)
		if err != nil {
			return master.State{}, false, err
		}
		payload, err := encode(next)
		if err != nil {
			return master.State{}, false, err
		}
		args := []any{cur.Version, dedupeWindow.Milliseconds(), s.ttl.Milliseconds(), syncevent.ChannelKey(roomID), payload}
		for field, value := range fields(next) {
			args = append(args, field, value)
		}
		res, err := casScript.Run(ctx, s.rdb, []string{stateKey, evtKey}, args...).Text()
		if err != nil {
			return master.State{}, false, err
		}
		switch res {
		case "OK":
			return next, false, nil
		case "DUP":
			continue // el siguiente intento devuelve el estado con dup=true
		}
		// Otra réplica escribió primero: espera aleatoria para no chocar de nuevo.
		if err := sleep(ctx, rand.N(maxBackoff)); err != nil {
			return master.State{}, false, err
		}
	}
	return master.State{}, false, fmt.Errorf("apply sala %s: %w tras %d intentos", roomID, errConflict, maxTxRetries)
}

func (s *Store) lockFor(roomID string) *sync.Mutex {
	h := fnv.New32a()
	_, _ = h.Write([]byte(roomID))
	return &s.locks[h.Sum32()%lockStripes]
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Touch refresca el periodo de gracia de la sala.
func (s *Store) Touch(ctx context.Context, roomID string) error {
	return s.rdb.PExpire(ctx, syncevent.StateKey(roomID), s.ttl).Err()
}

// HostSeen registra/refresca una conexión de host y devuelve cuántas hay vivas.
func (s *Store) HostSeen(ctx context.Context, roomID, connID string, nowMs int64) (int64, error) {
	key := syncevent.HostsKey(roomID)
	_, err := s.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.ZAdd(ctx, key, redis.Z{Score: float64(nowMs), Member: connID})
		p.PExpire(ctx, key, s.ttl)
		return nil
	})
	if err != nil {
		return 0, err
	}
	return s.OnlineHosts(ctx, roomID, nowMs)
}

// HostGone elimina una conexión de host y devuelve cuántas quedan vivas.
func (s *Store) HostGone(ctx context.Context, roomID, connID string, nowMs int64) (int64, error) {
	if err := s.rdb.ZRem(ctx, syncevent.HostsKey(roomID), connID).Err(); err != nil {
		return 0, err
	}
	return s.OnlineHosts(ctx, roomID, nowMs)
}

// OnlineHosts cuenta las conexiones de host que latieron dentro del timeout.
func (s *Store) OnlineHosts(ctx context.Context, roomID string, nowMs int64) (int64, error) {
	since := strconv.FormatInt(nowMs-PresenceTimeout.Milliseconds(), 10)
	return s.rdb.ZCount(ctx, syncevent.HostsKey(roomID), since, "+inf").Result()
}

func load(ctx context.Context, c redis.Cmdable, roomID string) (master.State, error) {
	m, err := c.HGetAll(ctx, syncevent.StateKey(roomID)).Result()
	if err != nil {
		return master.State{}, err
	}
	return decode(m)
}

func decode(m map[string]string) (master.State, error) {
	if len(m) == 0 {
		return master.State{}, ErrNotFound
	}
	return parse(m)
}

func fields(s master.State) map[string]any {
	return map[string]any{
		"status":        string(s.Status),
		"position_ms":   s.PositionMs,
		"updated_at_ms": s.UpdatedAtMs,
		"rate":          strconv.FormatFloat(s.Rate, 'f', -1, 64),
		"version":       s.Version,
		"host_id":       s.HostID,
		"media_id":      s.MediaID,
	}
}

func parse(m map[string]string) (master.State, error) {
	st := master.State{Status: master.Status(m["status"]), HostID: m["host_id"], MediaID: m["media_id"]}
	var err error
	ints := []struct {
		field string
		dst   *int64
	}{
		{"position_ms", &st.PositionMs},
		{"updated_at_ms", &st.UpdatedAtMs},
		{"version", &st.Version},
	}
	for _, f := range ints {
		if *f.dst, err = strconv.ParseInt(m[f.field], 10, 64); err != nil {
			return master.State{}, fmt.Errorf("estado corrupto (%s): %w", f.field, err)
		}
	}
	if st.Rate, err = strconv.ParseFloat(m["rate"], 64); err != nil {
		return master.State{}, fmt.Errorf("estado corrupto (rate): %w", err)
	}
	return st, nil
}
