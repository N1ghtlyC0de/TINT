// Package server — métricas de la sala y mensaje recap.
package server

import (
	"context"
	"encoding/json"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/recap"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// recapOpTimeout acota cada escritura de métricas: nunca deben frenar el
// camino de las reacciones ni el relay.
const recapOpTimeout = 500 * time.Millisecond

// recordReaction suma la reacción a los contadores del recap.
func (d *Deps) recordReaction(ctx context.Context, r socialevent.Reaction) {
	if d.Recap == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, recapOpTimeout)
	defer cancel()
	_ = d.Recap.RecordReaction(ctx, r.RoomID, r.UserID, r.Nick, r.Emoji, r.PositionMS)
}

// recordSync cuenta pausas y rebobinados del bus de sync (dedup en Redis
// entre réplicas) y mueve el ancla de reproducción. Se procesa en orden
// dentro del relay de la sala; ok = false sin Recap o si Redis falló.
func (d *Deps) recordSync(roomID string, ev socialevent.SyncEvent) (recap.Kind, bool) {
	if d.Recap == nil {
		return recap.KindNone, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), recapOpTimeout)
	defer cancel()
	kind, err := d.Recap.RecordSyncAt(ctx, roomID, ev, d.now())
	return kind, err == nil
}

// handleRecapRequest responde el recap solo a quien lo pidió.
func (d *Deps) handleRecapRequest(ctx context.Context, c *websocket.Conn, roomID string, raw []byte, claims auth.Claims, limiter *reactions.Limiter) {
	var in socialevent.RecapRequest
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if d.Recap == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
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
	out, err := d.Recap.Build(ctx, roomID)
	if err != nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	out.EventIDRef = in.EventID
	if msg, err := json.Marshal(out); err == nil {
		_ = writeMsg(ctx, c, msg, d.writeTimeout())
	}
}
