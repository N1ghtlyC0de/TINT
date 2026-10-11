// Package chat — hub de broadcast por sala.
package chat

import (
	"sync"
)

// Hub reparte mensajes solo dentro de la misma sala.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[string]chan<- []byte
}

// NewHub crea un hub vacío.
func NewHub() *Hub {
	return &Hub{rooms: make(map[string]map[string]chan<- []byte)}
}

// Join suscribe connID a roomID.
func (h *Hub) Join(roomID, connID string, ch chan<- []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	members, ok := h.rooms[roomID]
	if !ok {
		members = make(map[string]chan<- []byte)
		h.rooms[roomID] = members
	}
	members[connID] = ch
}

// Leave elimina la suscripción.
func (h *Hub) Leave(roomID, connID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	members, ok := h.rooms[roomID]
	if !ok {
		return
	}
	delete(members, connID)
	if len(members) == 0 {
		delete(h.rooms, roomID)
	}
}

// Members devuelve el número de conexiones en una sala (para tests/métricas).
func (h *Hub) Members(roomID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms[roomID])
}

// Broadcast envía msg a todos los miembros de roomID de forma no bloqueante.
// Devuelve cuántos lo recibieron (canal con buffer o con lector listo).
func (h *Hub) Broadcast(roomID string, msg []byte) int {
	h.mu.Lock()
	members := make([]chan<- []byte, 0, len(h.rooms[roomID]))
	for _, ch := range h.rooms[roomID] {
		members = append(members, ch)
	}
	h.mu.Unlock()
	delivered := 0
	for _, ch := range members {
		select {
		case ch <- msg:
			delivered++
		default:
		}
	}
	return delivered
}
