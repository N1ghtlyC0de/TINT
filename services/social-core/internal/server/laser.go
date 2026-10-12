// Package server — puntero láser del host (efímero, sin persistencia).
package server

import (
	"context"
	"encoding/json"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// LaserPerSecond es el máximo de puntos láser por usuario y segundo.
const LaserPerSecond = 30

// isModerator indica si los claims verificados prueban ser host o cohost de
// esta sala. Solo cuenta un HS256 de identity-api ligado a la sala (el
// sync-ticket del host): un Firebase ID token no dice de qué sala es dueño
// el usuario, así que no da permisos de moderación (falla cerrado).
func isModerator(c auth.Claims, roomID string) bool {
	if !c.IsGuest || c.RoomID == "" || c.RoomID != roomID {
		return false
	}
	return c.Role == "host" || c.Role == "cohost"
}

// handleLaser valida, autoriza (host/cohost), limita (30/s) y emite el
// puntero a la sala, incluidas las demás réplicas.
func (d *Deps) handleLaser(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte, limiter *reactions.Limiter) {
	var in socialevent.LaserPoint
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if !limiter.Allow(claims.Subject, d.now()) {
		writeError(ctx, c, "RATE_LIMITED", in.EventID)
		return
	}
	out := socialevent.Laser{
		EventID: d.newID(), Type: socialevent.TypeLaser, RoomID: roomID,
		UserID: claims.Subject, Nick: claims.Nick, X: in.X, Y: in.Y, End: in.End,
	}
	d.emitRoom(ctx, roomID, out.EventID, out)
}

// emitRoom publica v a las demás réplicas (si hay Redis) y lo emite a los
// clientes locales, tragando el eco por event_id.
func (d *Deps) emitRoom(ctx context.Context, roomID, eventID string, v any) {
	if d.PublishRaw != nil {
		if raw, err := json.Marshal(v); err == nil {
			_ = d.PublishRaw(ctx, roomID, raw)
		}
	}
	d.broadcastRawOnce(roomID, eventID, v)
}
