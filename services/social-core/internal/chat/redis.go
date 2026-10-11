// Package chat — historial corto en Redis.
package chat

import (
	"context"
	"encoding/json"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
	"github.com/redis/go-redis/v9"
)

// HistoryTTL es el periodo de gracia de la sala (REQ-07): 12 horas.
const HistoryTTL = 12 * time.Hour

// RedisStore persiste el historial corto (LIST) y publica en Pub/Sub.
type RedisStore struct {
	client *redis.Client
	limit  int
	ttl    time.Duration
}

// NewRedisStore crea el store sobre la URL dada.
func NewRedisStore(url string, limit int, ttl time.Duration) (*RedisStore, error) {
	if limit <= 0 {
		limit = HistoryLimit
	}
	if ttl <= 0 {
		ttl = HistoryTTL
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	return &RedisStore{client: redis.NewClient(opt), limit: limit, ttl: ttl}, nil
}

// NewRedisStoreWithClient inyecta un cliente (tests/integración).
func NewRedisStoreWithClient(client *redis.Client, limit int, ttl time.Duration) *RedisStore {
	if limit <= 0 {
		limit = HistoryLimit
	}
	if ttl <= 0 {
		ttl = HistoryTTL
	}
	return &RedisStore{client: client, limit: limit, ttl: ttl}
}

func (s *RedisStore) Push(ctx context.Context, roomID string, msg socialevent.ChatMessage) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	key := HistoryKey(roomID)
	pipe := s.client.Pipeline()
	pipe.LPush(ctx, key, raw)
	pipe.LTrim(ctx, key, 0, int64(s.limit-1))
	pipe.Expire(ctx, key, s.ttl)
	_, err = pipe.Exec(ctx)
	return err
}

func (s *RedisStore) Recent(ctx context.Context, roomID string, limit int) ([]socialevent.ChatMessage, error) {
	if limit <= 0 {
		limit = s.limit
	}
	raws, err := s.client.LRange(ctx, HistoryKey(roomID), 0, int64(limit-1)).Result()
	if err != nil {
		return nil, err
	}
	// LPUSH guarda newest-first: invertimos a cronológico.
	out := make([]socialevent.ChatMessage, 0, len(raws))
	for i := len(raws) - 1; i >= 0; i-- {
		var m socialevent.ChatMessage
		if err := json.Unmarshal([]byte(raws[i]), &m); err != nil {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

// Publish emite el mensaje al canal de la sala (multirréplica).
func (s *RedisStore) Publish(ctx context.Context, roomID string, msg socialevent.ChatMessage) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return s.client.Publish(ctx, ChannelKey(roomID), raw).Err()
}

// PublishReaction emite una reacción al canal de la sala (multirréplica).
func (s *RedisStore) PublishReaction(ctx context.Context, roomID string, r socialevent.Reaction) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return s.client.Publish(ctx, ChannelKey(roomID), raw).Err()
}

// IsRevoked indica si identity-api revocó el jti (EXISTS token:revoked:{jti}).
// Un error de Redis se devuelve tal cual: el llamador debe fallar cerrado.
func (s *RedisStore) IsRevoked(ctx context.Context, jti string) (bool, error) {
	n, err := s.client.Exists(ctx, RevokedKey(jti)).Result()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Subscribe abre UNA suscripción por sala a room:{id}:social (eventos de
// otras réplicas) y room:{id}:sync (solo para REVOKED de identity-api).
func (s *RedisStore) Subscribe(ctx context.Context, roomID string) (<-chan Inbound, func()) {
	out := make(chan Inbound, 64)
	social, sync := ChannelKey(roomID), SyncChannelKey(roomID)
	sub := s.client.Subscribe(ctx, social, sync)
	ch := sub.Channel()
	done := make(chan struct{})
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case payload, ok := <-ch:
				if !ok {
					return
				}
				in, ok := decodeInbound(payload.Channel == sync, []byte(payload.Payload))
				if !ok {
					continue
				}
				if in.RevokedJTI != "" {
					// Una revocación no se descarta aunque el buffer esté lleno.
					select {
					case out <- in:
					case <-ctx.Done():
						return
					case <-done:
						return
					}
					continue
				}
				select {
				case out <- in:
				default:
				}
			}
		}
	}()
	return out, func() { close(done); _ = sub.Close() }
}

// decodeInbound traduce un payload de Pub/Sub. Del canal de sync solo
// interesa REVOKED; del social, los chat_message y reaction de otras
// réplicas (se re-serializan por tipo: nunca se reenvía JSON arbitrario).
func decodeInbound(fromSync bool, raw []byte) (Inbound, bool) {
	if fromSync {
		var ev struct {
			Type string `json:"type"`
			JTI  string `json:"jti"`
		}
		if json.Unmarshal(raw, &ev) != nil || ev.Type != "REVOKED" || ev.JTI == "" {
			return Inbound{}, false
		}
		return Inbound{RevokedJTI: ev.JTI}, true
	}
	var head struct {
		Type    socialevent.Type `json:"type"`
		EventID string           `json:"event_id"`
	}
	if json.Unmarshal(raw, &head) != nil || head.EventID == "" {
		return Inbound{}, false
	}
	var v any
	switch head.Type {
	case socialevent.TypeChatMessage:
		v = &socialevent.ChatMessage{}
	case socialevent.TypeReaction:
		v = &socialevent.Reaction{}
	default:
		return Inbound{}, false
	}
	if json.Unmarshal(raw, v) != nil {
		return Inbound{}, false
	}
	payload, err := json.Marshal(v)
	if err != nil {
		return Inbound{}, false
	}
	return Inbound{EventID: head.EventID, Payload: payload}, true
}

// TrackChat publica telemetría sin texto (solo message_length, Ley 1581).
func (s *RedisStore) TrackChat(ctx context.Context, msg socialevent.ChatMessage, length int) error {
	return s.client.XAdd(ctx, &redis.XAddArgs{
		Stream: "analytics:events",
		Values: map[string]any{
			"event_id":       msg.EventID,
			"type":           "chat_message",
			"room_id":        msg.RoomID,
			"message_length": length,
			"occurred_at":    msg.OccurredAt.UTC().Format(time.RFC3339Nano),
		},
	}).Err()
}

// Close libera el cliente.
func (s *RedisStore) Close() error {
	return s.client.Close()
}
