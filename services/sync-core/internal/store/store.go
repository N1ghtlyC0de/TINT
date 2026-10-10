// Package store persiste el Reloj Maestro de cada sala en Redis
// (room:{id}:sync_state) y la presencia de hosts entre réplicas.
//
// Los comandos usan una transacción optimista (WATCH/MULTI/EXEC): se lee el
// estado, se calcula el siguiente con master.Apply (única fuente de verdad)
// y se escribe + publica atómicamente. Si otra réplica modificó la sala en
// medio, EXEC falla y se reintenta, así ningún comando se pierde.
package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
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
)

var (
	ErrNotFound = errors.New("la sala no tiene estado de sincronización")
	errConflict = errors.New("conflicto de escritura concurrente")
)

// Encoder construye el payload que se publica a todas las réplicas.
type Encoder func(master.State) ([]byte, error)

// Store es el repositorio Redis del dominio de sincronización.
type Store struct {
	rdb redis.UniversalClient
	ttl time.Duration
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
	stateKey := syncevent.StateKey(roomID)
	evtKey := syncevent.EventKey(roomID, eventID)
	var (
		result master.State
		dup    bool
	)
	txf := func(tx *redis.Tx) error {
		seen, err := tx.Exists(ctx, evtKey).Result()
		if err != nil {
			return err
		}
		cur, err := load(ctx, tx, roomID)
		if err != nil {
			return err
		}
		if seen > 0 {
			result, dup = cur, true
			return nil
		}
		next, err := cur.Apply(cmd, receivedAtMs, rttMs)
		if err != nil {
			return err
		}
		payload, err := encode(next)
		if err != nil {
			return err
		}
		_, err = tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
			p.Set(ctx, evtKey, 1, dedupeWindow)
			p.HSet(ctx, stateKey, fields(next))
			p.PExpire(ctx, stateKey, s.ttl)
			p.Publish(ctx, syncevent.ChannelKey(roomID), payload)
			return nil
		})
		if errors.Is(err, redis.TxFailedErr) {
			return errConflict
		}
		result, dup = next, false
		return err
	}
	for i := 0; i < maxTxRetries; i++ {
		err := s.rdb.Watch(ctx, txf, stateKey, evtKey)
		if errors.Is(err, errConflict) || errors.Is(err, redis.TxFailedErr) {
			continue
		}
		if err != nil {
			return master.State{}, false, err
		}
		return result, dup, nil
	}
	return master.State{}, false, fmt.Errorf("apply sala %s: %w tras %d intentos", roomID, errConflict, maxTxRetries)
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
	}
}

func parse(m map[string]string) (master.State, error) {
	st := master.State{Status: master.Status(m["status"]), HostID: m["host_id"]}
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
