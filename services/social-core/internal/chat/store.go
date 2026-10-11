// Package chat implementa el hub en memoria y el historial corto del chat.
package chat

import (
	"context"
	"sync"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// HistoryLimit por defecto (últimos N mensajes por sala).
const HistoryLimit = socialevent.HistoryLimit

// Store guarda el historial corto de chat.
type Store interface {
	Push(ctx context.Context, roomID string, msg socialevent.ChatMessage) error
	Recent(ctx context.Context, roomID string, limit int) ([]socialevent.ChatMessage, error)
}

// MemoryStore es la implementación en memoria (dev/test y fallback sin Redis).
type MemoryStore struct {
	mu    sync.Mutex
	limit int
	rooms map[string][]socialevent.ChatMessage
}

// NewMemoryStore crea un store en memoria con el límite dado.
func NewMemoryStore(limit int) *MemoryStore {
	if limit <= 0 {
		limit = HistoryLimit
	}
	return &MemoryStore{limit: limit, rooms: make(map[string][]socialevent.ChatMessage)}
}

func (s *MemoryStore) Push(_ context.Context, roomID string, msg socialevent.ChatMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := append(s.rooms[roomID], msg)
	if len(items) > s.limit {
		items = items[len(items)-s.limit:]
	}
	s.rooms[roomID] = items
	return nil
}

func (s *MemoryStore) Recent(_ context.Context, roomID string, limit int) ([]socialevent.ChatMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := s.rooms[roomID]
	if limit <= 0 || limit > len(items) {
		limit = len(items)
	}
	out := make([]socialevent.ChatMessage, limit)
	copy(out, items[len(items)-limit:])
	return out, nil
}

// HistoryKey es la clave Redis del historial de una sala.
func HistoryKey(roomID string) string {
	return "room:" + roomID + ":chat:history"
}

// ChannelKey es el canal Pub/Sub de una sala.
func ChannelKey(roomID string) string {
	return "room:" + roomID + ":social"
}
