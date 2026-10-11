// Package bus distribuye los mensajes de cada sala entre réplicas de
// sync-core mediante Redis Pub/Sub (room:{id}:sync, SYNC-BE-05).
//
// Cada réplica mantiene una sola conexión Pub/Sub y se suscribe solo a las
// salas que tienen clientes locales.
package bus

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// Handler recibe cada mensaje publicado en una sala suscrita.
type Handler func(roomID string, payload []byte)

// Bus es el adaptador Redis Pub/Sub.
type Bus struct {
	rdb redis.UniversalClient
	ps  *redis.PubSub
}

// New crea el bus; Start debe llamarse antes de suscribirse.
func New(rdb redis.UniversalClient) *Bus {
	return &Bus{rdb: rdb}
}

// Start abre la conexión Pub/Sub y entrega los mensajes a h hasta que ctx
// se cancele o se llame Close.
func (b *Bus) Start(ctx context.Context, h Handler) {
	b.ps = b.rdb.Subscribe(ctx)
	ch := b.ps.Channel()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				if room := roomFromChannel(msg.Channel); room != "" {
					h(room, []byte(msg.Payload))
				}
			}
		}
	}()
}

// Subscribe empieza a recibir los mensajes de la sala.
func (b *Bus) Subscribe(ctx context.Context, roomID string) error {
	return b.ps.Subscribe(ctx, syncevent.ChannelKey(roomID))
}

// Unsubscribe deja de recibir los mensajes de la sala.
func (b *Bus) Unsubscribe(ctx context.Context, roomID string) error {
	return b.ps.Unsubscribe(ctx, syncevent.ChannelKey(roomID))
}

// Publish envía payload a todas las réplicas suscritas a la sala.
func (b *Bus) Publish(ctx context.Context, roomID string, payload []byte) error {
	return b.rdb.Publish(ctx, syncevent.ChannelKey(roomID), payload).Err()
}

// Close cierra la conexión Pub/Sub.
func (b *Bus) Close() error {
	return b.ps.Close()
}

func roomFromChannel(channel string) string {
	const prefix, suffix = "room:", ":sync"
	if !strings.HasPrefix(channel, prefix) || !strings.HasSuffix(channel, suffix) || len(channel) <= len(prefix)+len(suffix) {
		return ""
	}
	return channel[len(prefix) : len(channel)-len(suffix)]
}
