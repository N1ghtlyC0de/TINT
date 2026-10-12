// Package moderation guarda la moderación del chat en Redis (multirréplica).
//
// Claves (TTL 12 h, el periodo de gracia de la sala):
//   - room:{id}:chat:settings   Hash slow_mode_s (0 = apagado).
//   - room:{id}:chat:muted      Set de user_id silenciados.
//   - room:{id}:chat:last:{sub} String con PX = modo lento: el último
//     mensaje aceptado de ese sub (vale entre réplicas y pestañas).
package moderation

import (
	"context"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// DefaultTTL es el periodo de gracia de la sala (REQ-07).
const DefaultTTL = 12 * time.Hour

// SlowModes son los valores aceptados de slow_mode_s.
var SlowModes = []int{0, 5, 10, 30, 60}

// ValidSlowMode indica si s es uno de SlowModes.
func ValidSlowMode(s int) bool {
	for _, ok := range SlowModes {
		if s == ok {
			return true
		}
	}
	return false
}

// Settings es el estado de moderación del chat de una sala.
type Settings struct {
	SlowModeS    int
	MutedUserIDs []string // ordenados; nunca nil
}

// Verdict es la decisión sobre un chat_send de un participante.
type Verdict struct {
	Muted        bool
	RetryAfterMS int64 // > 0 = frenado por el modo lento
}

// Store es el almacén Redis de moderación.
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

// SettingsKey es el hash de ajustes del chat.
func SettingsKey(roomID string) string { return "room:" + roomID + ":chat:settings" }

// MutedKey es el set de silenciados.
func MutedKey(roomID string) string { return "room:" + roomID + ":chat:muted" }

// LastKey es la marca de modo lento de un usuario.
func LastKey(roomID, sub string) string { return "room:" + roomID + ":chat:last:" + sub }

// admitScript: -1 silenciado; 0 pasa (y toma la marca si hay modo lento);
// > 0 ms que faltan para poder escribir.
var admitScript = redis.NewScript(`
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return -1 end
local slow = tonumber(redis.call('HGET', KEYS[2], 'slow_mode_s') or '0') or 0
if slow <= 0 then return 0 end
if redis.call('SET', KEYS[3], '1', 'NX', 'PX', slow * 1000) then return 0 end
local left = redis.call('PTTL', KEYS[3])
if left <= 0 then left = slow * 1000 end
return left
`)

// Admit decide si sub puede escribir ahora. Un error de Redis se devuelve
// tal cual: el llamador debe fallar cerrado.
func (s *Store) Admit(ctx context.Context, roomID, sub string) (Verdict, error) {
	n, err := admitScript.Run(ctx, s.client,
		[]string{MutedKey(roomID), SettingsKey(roomID), LastKey(roomID, sub)}, sub).Int64()
	if err != nil {
		return Verdict{}, err
	}
	if n < 0 {
		return Verdict{Muted: true}, nil
	}
	return Verdict{RetryAfterMS: n}, nil
}

// SetSlowMode fija slow_mode_s (el llamador valida con ValidSlowMode).
func (s *Store) SetSlowMode(ctx context.Context, roomID string, seconds int) error {
	_, err := s.client.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, SettingsKey(roomID), "slow_mode_s", seconds)
		p.Expire(ctx, SettingsKey(roomID), s.ttl)
		return nil
	})
	return err
}

// SetMuted silencia (o quita el silencio a) userID.
func (s *Store) SetMuted(ctx context.Context, roomID, userID string, muted bool) error {
	_, err := s.client.TxPipelined(ctx, func(p redis.Pipeliner) error {
		if muted {
			p.SAdd(ctx, MutedKey(roomID), userID)
		} else {
			p.SRem(ctx, MutedKey(roomID), userID)
		}
		p.Expire(ctx, MutedKey(roomID), s.ttl)
		return nil
	})
	return err
}

// Settings lee el estado de moderación de la sala.
func (s *Store) Settings(ctx context.Context, roomID string) (Settings, error) {
	pipe := s.client.Pipeline()
	slow := pipe.HGet(ctx, SettingsKey(roomID), "slow_mode_s")
	muted := pipe.SMembers(ctx, MutedKey(roomID))
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return Settings{}, err
	}
	out := Settings{MutedUserIDs: muted.Val()}
	if out.MutedUserIDs == nil {
		out.MutedUserIDs = []string{}
	}
	sort.Strings(out.MutedUserIDs)
	out.SlowModeS, _ = strconv.Atoi(slow.Val())
	return out, nil
}
