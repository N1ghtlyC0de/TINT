// Package polls guarda las encuestas en vivo en Redis (multirréplica).
//
// Claves (TTL 12 h, el periodo de gracia de la sala):
//   - room:{id}:poll            Hash id, question, options (JSON), n_options,
//     closes_at_ms y closed (solo existe al cerrarse; HSETNX = idempotente).
//   - room:{id}:poll:{pid}:votes Hash user_id → índice de opción (un voto
//     por usuario, cambiable).
//   - room:{id}:poll:flush       String con PX: hay un broadcast coalescido
//     pendiente en alguna réplica.
//
// Toda decisión (una activa por sala, votar solo si está abierta, cerrar una
// vez) se toma en un script Lua atómico; el instante "ahora" lo pasa el
// llamador (reloj inyectado), nunca el de Redis.
package polls

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// DefaultTTL es el periodo de gracia de la sala (REQ-07).
const DefaultTTL = 12 * time.Hour

// flushGuard acota la marca de flush si la réplica que la tomó se cae.
const flushGuard = 2 * time.Second

var (
	ErrActive   = errors.New("ya hay una encuesta activa en la sala")
	ErrNotFound = errors.New("la encuesta no existe o ya no es la actual")
	ErrClosed   = errors.New("la encuesta está cerrada")
	ErrOption   = errors.New("opción fuera de rango")
)

// Poll es la encuesta actual de una sala.
type Poll struct {
	ID         string
	Question   string
	Options    []string
	ClosesAtMS int64
	Closed     bool // cerrada explícitamente (manual o por el timer)
}

// Store es el almacén Redis de encuestas.
type Store struct {
	client *redis.Client
	ttl    time.Duration
}

// NewStore crea el store; ttl ≤ 0 = DefaultTTL.
func NewStore(client *redis.Client, ttl time.Duration) *Store {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Store{client: client, ttl: ttl}
}

// PollKey es el hash de la encuesta actual de la sala.
func PollKey(roomID string) string { return "room:" + roomID + ":poll" }

// VotesKey es el hash de votos de una encuesta.
func VotesKey(roomID, pollID string) string { return "room:" + roomID + ":poll:" + pollID + ":votes" }

// FlushKey marca un broadcast de votos pendiente en la sala.
func FlushKey(roomID string) string { return "room:" + roomID + ":poll:flush" }

// createScript: solo crea si no hay encuesta, si está cerrada o si venció.
var createScript = redis.NewScript(`
local cur = redis.call('HMGET', KEYS[1], 'id', 'closed', 'closes_at_ms')
if cur[1] and not cur[2] and tonumber(cur[3]) > tonumber(ARGV[1]) then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'id', ARGV[2], 'question', ARGV[3], 'options', ARGV[4], 'n_options', ARGV[5], 'closes_at_ms', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[7])
return 1
`)

// voteScript: -1 no existe, -2 cerrada o vencida, -3 opción inválida, 1 ok.
var voteScript = redis.NewScript(`
local cur = redis.call('HMGET', KEYS[1], 'id', 'closed', 'closes_at_ms', 'n_options')
if not cur[1] or cur[1] ~= ARGV[1] then return -1 end
if cur[2] or tonumber(cur[3]) <= tonumber(ARGV[2]) then return -2 end
local opt = tonumber(ARGV[4])
if opt < 0 or opt >= tonumber(cur[4]) then return -3 end
redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return 1
`)

// closeScript: -1 no existe; si no, el resultado de HSETNX (1 = la cerré yo).
var closeScript = redis.NewScript(`
local id = redis.call('HGET', KEYS[1], 'id')
if not id or id ~= ARGV[1] then return -1 end
return redis.call('HSETNX', KEYS[1], 'closed', '1')
`)

func (s *Store) ttlSeconds() int64 { return int64(s.ttl / time.Second) }

// Create guarda p como la encuesta actual; ErrActive si hay otra abierta.
func (s *Store) Create(ctx context.Context, roomID string, p Poll, nowMS int64) error {
	options, err := json.Marshal(p.Options)
	if err != nil {
		return err
	}
	n, err := createScript.Run(ctx, s.client, []string{PollKey(roomID)},
		nowMS, p.ID, p.Question, string(options), len(p.Options), p.ClosesAtMS, s.ttlSeconds()).Int64()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrActive
	}
	return nil
}

// Vote registra (o cambia) el voto de userID.
func (s *Store) Vote(ctx context.Context, roomID, pollID, userID string, option int, nowMS int64) error {
	n, err := voteScript.Run(ctx, s.client, []string{PollKey(roomID), VotesKey(roomID, pollID)},
		pollID, nowMS, userID, option, s.ttlSeconds()).Int64()
	if err != nil {
		return err
	}
	switch n {
	case -1:
		return ErrNotFound
	case -2:
		return ErrClosed
	case -3:
		return ErrOption
	}
	return nil
}

// Close marca la encuesta cerrada. true = esta llamada la cerró; false = ya
// estaba cerrada (idempotente entre réplicas y entre timer y host).
func (s *Store) Close(ctx context.Context, roomID, pollID string) (bool, error) {
	n, err := closeScript.Run(ctx, s.client, []string{PollKey(roomID)}, pollID).Int64()
	if err != nil {
		return false, err
	}
	if n == -1 {
		return false, ErrNotFound
	}
	return n == 1, nil
}

// Current devuelve la encuesta actual de la sala (ok=false si no hay).
func (s *Store) Current(ctx context.Context, roomID string) (Poll, bool, error) {
	h, err := s.client.HGetAll(ctx, PollKey(roomID)).Result()
	if err != nil {
		return Poll{}, false, err
	}
	if h["id"] == "" {
		return Poll{}, false, nil
	}
	p := Poll{ID: h["id"], Question: h["question"], Closed: h["closed"] != ""}
	if err := json.Unmarshal([]byte(h["options"]), &p.Options); err != nil {
		return Poll{}, false, err
	}
	p.ClosesAtMS, _ = strconv.ParseInt(h["closes_at_ms"], 10, 64)
	return p, true, nil
}

// Counts cuenta los votos por opción (n opciones; ignora valores inválidos).
func (s *Store) Counts(ctx context.Context, roomID, pollID string, n int) ([]int64, error) {
	votes, err := s.client.HVals(ctx, VotesKey(roomID, pollID)).Result()
	if err != nil {
		return nil, err
	}
	counts := make([]int64, n)
	for _, v := range votes {
		i, err := strconv.Atoi(v)
		if err != nil || i < 0 || i >= n {
			continue
		}
		counts[i]++
	}
	return counts, nil
}

// VoteOf devuelve el voto de userID (ok=false si no votó).
func (s *Store) VoteOf(ctx context.Context, roomID, pollID, userID string) (int, bool, error) {
	v, err := s.client.HGet(ctx, VotesKey(roomID, pollID), userID).Result()
	if errors.Is(err, redis.Nil) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return 0, false, nil
	}
	return i, true, nil
}

// TryFlush toma la marca de broadcast pendiente de la sala: true = esta
// réplica debe emitir el poll_state coalescido (nadie más lo tiene agendado).
func (s *Store) TryFlush(ctx context.Context, roomID string) (bool, error) {
	return s.client.SetNX(ctx, FlushKey(roomID), "1", flushGuard).Result()
}

// ReleaseFlush suelta la marca antes de leer los conteos: un voto que llegue
// después de la lectura vuelve a tomarla y agenda otro broadcast.
func (s *Store) ReleaseFlush(ctx context.Context, roomID string) error {
	return s.client.Del(ctx, FlushKey(roomID)).Err()
}
