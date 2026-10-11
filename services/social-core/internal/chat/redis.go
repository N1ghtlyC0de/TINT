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

// Subscribe devuelve un canal con los mensajes publicados por otras réplicas.
func (s *RedisStore) Subscribe(ctx context.Context, roomID string) (<-chan socialevent.ChatMessage, func()) {
	out := make(chan socialevent.ChatMessage, 64)
	sub := s.client.Subscribe(ctx, ChannelKey(roomID))
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
				var m socialevent.ChatMessage
				if err := json.Unmarshal([]byte(payload.Payload), &m); err != nil {
					continue
				}
				select {
				case out <- m:
				default:
				}
			}
		}
	}()
	return out, func() { close(done); _ = sub.Close() }
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
