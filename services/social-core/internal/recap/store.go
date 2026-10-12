// Package recap acumula en Redis las métricas de la sala para el mensaje
// recap (multirréplica). Claves (TTL 12 h, el periodo de gracia de la sala):
//
//   - room:{id}:recap:emojis_by_user Hash user_id → reacciones enviadas
//   - room:{id}:recap:nicks          Hash user_id → último nick
//   - room:{id}:recap:reactions      Hash bucket (5 s) → reacciones
//   - room:{id}:recap:laughs         Hash bucket → reacciones 😂
//   - room:{id}:recap:pauses         Hash bucket → pausas + rebobinados
//   - room:{id}:recap:totals         Hash reactions, pauses, rewinds, polls
//   - room:{id}:recap:last_pos       Hash ancla de reproducción conocida
//     (pos, status, rate, updated_at_ms, version)
//   - room:{id}:recap:seen:{event_id} String, EX 1 h: dedup de los eventos
//     del bus de sync entre réplicas
package recap

import (
	"context"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

const (
	// DefaultTTL es el periodo de gracia de la sala (REQ-07).
	DefaultTTL = 12 * time.Hour
	// SeenTTL es la ventana de dedup de eventos del bus de sync.
	SeenTTL = time.Hour
	// BucketMS es el tamaño de bucket (igual que el heatmap).
	BucketMS = 5000
	// RewindToleranceMS: un SEEK cuenta como rebobinado si retrocede más que
	// esto respecto a la posición proyectada (absorbe RTT y redondeos).
	RewindToleranceMS = 1000
	// LaughEmoji es la reacción que cuenta como risa.
	LaughEmoji = "😂"
)

// Kind clasifica un evento de sync procesado.
type Kind int

const (
	KindDuplicate Kind = -1 // otra réplica ya lo contó
	KindNone      Kind = 0  // actualiza el ancla, no cuenta
	KindPause     Kind = 1
	KindRewind    Kind = 2
)

// Store es el acumulador Redis del recap.
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

func key(roomID, name string) string { return "room:" + roomID + ":recap:" + name }

// Claves Redis del recap.
func EmojisByUserKey(roomID string) string { return key(roomID, "emojis_by_user") }
func NicksKey(roomID string) string        { return key(roomID, "nicks") }
func ReactionsKey(roomID string) string    { return key(roomID, "reactions") }
func LaughsKey(roomID string) string       { return key(roomID, "laughs") }
func PausesKey(roomID string) string       { return key(roomID, "pauses") }
func TotalsKey(roomID string) string       { return key(roomID, "totals") }
func LastPosKey(roomID string) string      { return key(roomID, "last_pos") }
func SeenKey(roomID, eventID string) string {
	return key(roomID, "seen:"+eventID)
}

func bucketOf(positionMS int64) string {
	if positionMS < 0 {
		positionMS = 0
	}
	return strconv.FormatInt(positionMS/BucketMS, 10)
}

// RecordReaction suma una reacción a los contadores (una ida a Redis).
func (s *Store) RecordReaction(ctx context.Context, roomID, userID, nick, emoji string, positionMS int64) error {
	bucket := bucketOf(positionMS)
	_, err := s.client.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HIncrBy(ctx, EmojisByUserKey(roomID), userID, 1)
		p.HSet(ctx, NicksKey(roomID), userID, nick)
		p.HIncrBy(ctx, ReactionsKey(roomID), bucket, 1)
		p.HIncrBy(ctx, TotalsKey(roomID), "reactions", 1)
		keys := []string{EmojisByUserKey(roomID), NicksKey(roomID), ReactionsKey(roomID), TotalsKey(roomID)}
		if emoji == LaughEmoji {
			p.HIncrBy(ctx, LaughsKey(roomID), bucket, 1)
			keys = append(keys, LaughsKey(roomID))
		}
		for _, k := range keys {
			p.Expire(ctx, k, s.ttl)
		}
		return nil
	})
	return err
}

// RecordPoll cuenta una encuesta creada.
func (s *Store) RecordPoll(ctx context.Context, roomID string) error {
	_, err := s.client.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HIncrBy(ctx, TotalsKey(roomID), "polls", 1)
		p.Expire(ctx, TotalsKey(roomID), s.ttl)
		return nil
	})
	return err
}

// syncScript deduplica, clasifica y actualiza el ancla en un solo paso
// atómico. Un SEEK es rebobinado si cae por debajo de la posición
// proyectada del ancla previa (si se estaba reproduciendo, avanza con
// updated_at_ms y rate). Un evento con version menor que el ancla llegó
// tarde: un PAUSE cuenta igual, pero no se clasifica un SEEK ni se mueve
// el ancla.
var syncScript = redis.NewScript(`
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[9]) then return -1 end
local prev = redis.call('HMGET', KEYS[2], 'pos', 'status', 'rate', 'updated_at_ms', 'version')
local pos = tonumber(ARGV[2])
local ver = tonumber(ARGV[6])
local stale = prev[5] and ver > 0 and tonumber(prev[5]) > ver
local kind = 0
if ARGV[1] == 'PAUSE' then
  kind = 1
elseif ARGV[1] == 'SEEK' and prev[1] and not stale then
  local expected = tonumber(prev[1])
  local upd = tonumber(ARGV[5])
  local pupd = tonumber(prev[4]) or 0
  if prev[2] == 'playing' and upd > pupd and pupd > 0 then
    local rate = tonumber(prev[3]) or 1
    if rate <= 0 then rate = 1 end
    expected = expected + math.floor((upd - pupd) * rate)
  end
  if pos < expected - tonumber(ARGV[10]) then kind = 2 end
end
if not stale then
  redis.call('HSET', KEYS[2], 'pos', ARGV[2], 'status', ARGV[3], 'rate', ARGV[4], 'updated_at_ms', ARGV[5], 'version', ARGV[6])
  redis.call('EXPIRE', KEYS[2], ARGV[7])
end
if kind > 0 then
  redis.call('HINCRBY', KEYS[3], ARGV[8], 1)
  redis.call('EXPIRE', KEYS[3], ARGV[7])
  local field = 'pauses'
  if kind == 2 then field = 'rewinds' end
  redis.call('HINCRBY', KEYS[4], field, 1)
  redis.call('EXPIRE', KEYS[4], ARGV[7])
end
return kind
`)

// RecordSync procesa un comando de reproducción leído del bus de sync. El
// bucket de un rebobinado es el destino del SEEK (el momento que se
// vuelve a ver).
func (s *Store) RecordSync(ctx context.Context, roomID string, ev socialevent.SyncEvent) (Kind, error) {
	rate := ev.Rate
	if rate <= 0 {
		rate = 1
	}
	keys := []string{SeenKey(roomID, ev.EventID), LastPosKey(roomID), PausesKey(roomID), TotalsKey(roomID)}
	n, err := syncScript.Run(ctx, s.client, keys,
		ev.Type, ev.PositionMS, ev.Status, strconv.FormatFloat(rate, 'f', -1, 64), ev.UpdatedAtMS, ev.Version,
		int64(s.ttl/time.Second), bucketOf(ev.PositionMS), int64(SeenTTL/time.Second), RewindToleranceMS).Int64()
	if err != nil {
		return KindNone, err
	}
	return Kind(n), nil
}

// Build arma el recap de la sala. Los empates se resuelven de forma estable:
// el bucket más temprano y el user_id menor.
func (s *Store) Build(ctx context.Context, roomID string) (socialevent.Recap, error) {
	out := socialevent.Recap{Type: socialevent.TypeRecap, RoomID: roomID}
	pipe := s.client.Pipeline()
	byUser := pipe.HGetAll(ctx, EmojisByUserKey(roomID))
	reactions := pipe.HGetAll(ctx, ReactionsKey(roomID))
	laughs := pipe.HGetAll(ctx, LaughsKey(roomID))
	pauses := pipe.HGetAll(ctx, PausesKey(roomID))
	totals := pipe.HGetAll(ctx, TotalsKey(roomID))
	if _, err := pipe.Exec(ctx); err != nil {
		return out, err
	}

	if user, n, ok := maxEntry(byUser.Val(), func(a, b string) bool { return a < b }); ok {
		nick, err := s.client.HGet(ctx, NicksKey(roomID), user).Result()
		if err != nil && err != redis.Nil {
			return out, err
		}
		out.TopEmojiUser = &socialevent.TopEmojiUser{UserID: user, Nick: nick, Count: n}
	}
	if b, n, ok := maxEntry(pauses.Val(), bucketLess); ok {
		out.MostPaused = &socialevent.PositionCount{PositionMS: bucketStart(b), Count: n}
	}
	if b, n, ok := maxEntry(reactions.Val(), bucketLess); ok {
		l, _ := strconv.ParseInt(laughs.Val()[b], 10, 64)
		out.PeakReactions = &socialevent.PeakReactions{PositionMS: bucketStart(b), Count: n, Laughs: l}
	}
	t := totals.Val()
	out.Totals = socialevent.RecapTotals{
		Reactions: atoi(t["reactions"]), Pauses: atoi(t["pauses"]),
		Rewinds: atoi(t["rewinds"]), Polls: atoi(t["polls"]),
	}
	return out, nil
}

// maxEntry devuelve la clave con mayor conteo (> 0); empate → la menor
// según less.
func maxEntry(h map[string]string, less func(a, b string) bool) (string, int64, bool) {
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return less(keys[i], keys[j]) })
	var best string
	var bestN int64
	for _, k := range keys {
		if n := atoi(h[k]); n > bestN {
			best, bestN = k, n
		}
	}
	return best, bestN, bestN > 0
}

func bucketLess(a, b string) bool { return atoi(a) < atoi(b) }

func bucketStart(bucket string) int64 { return atoi(bucket) * BucketMS }

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}
