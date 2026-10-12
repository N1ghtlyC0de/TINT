// Package server — moderación del chat: modo lento y silencio.
//
// El estado vive en Redis (internal/moderation) para que valga entre
// réplicas y pestañas; los cambios se emiten como chat_settings a la sala.
// Host y cohost quedan exentos del modo lento y del silencio.
package server

import (
	"context"
	"encoding/json"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func (d *Deps) handleSlowMode(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte) {
	var in socialevent.ChatSlowMode
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if d.Moderation == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if err := d.Moderation.SetSlowMode(ctx, roomID, *in.Seconds); err != nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	d.broadcastChatSettings(ctx, roomID)
}

func (d *Deps) handleMute(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte) {
	var in socialevent.ChatMute
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if d.Moderation == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if err := d.Moderation.SetMuted(ctx, roomID, trimText(in.UserID), *in.Muted); err != nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	d.broadcastChatSettings(ctx, roomID)
}

// chatSettings lee el estado actual; ok=false sin Redis o si falla.
func (d *Deps) chatSettings(ctx context.Context, roomID string) (socialevent.ChatSettings, bool) {
	if d.Moderation == nil {
		return socialevent.ChatSettings{}, false
	}
	st, err := d.Moderation.Settings(ctx, roomID)
	if err != nil {
		return socialevent.ChatSettings{}, false
	}
	return socialevent.ChatSettings{
		EventID: d.newID(), Type: socialevent.TypeChatSettings, RoomID: roomID,
		SlowModeS: st.SlowModeS, MutedUserIDs: st.MutedUserIDs,
	}, true
}

func (d *Deps) broadcastChatSettings(ctx context.Context, roomID string) {
	if st, ok := d.chatSettings(ctx, roomID); ok {
		d.emitRoom(ctx, roomID, st.EventID, st)
	}
}

// sendChatSettingsOnJoin envía el estado de moderación al que entra.
func (d *Deps) sendChatSettingsOnJoin(ctx context.Context, c *websocket.Conn, roomID string) {
	if st, ok := d.chatSettings(ctx, roomID); ok {
		if raw, err := json.Marshal(st); err == nil {
			_ = writeMsg(ctx, c, raw, d.writeTimeout())
		}
	}
}

// admitChat aplica silencio y modo lento a un participante. Devuelve el
// error a enviar (vacío = pasa) y, para SLOW_MODE, los ms que faltan. Sin
// Redis no hay moderación; con Redis caído falla cerrado (UNAVAILABLE).
func (d *Deps) admitChat(ctx context.Context, roomID string, claims auth.Claims) (code string, retryAfterMS int64) {
	if d.Moderation == nil || isModerator(claims, roomID) {
		return "", 0
	}
	v, err := d.Moderation.Admit(ctx, roomID, claims.Subject)
	switch {
	case err != nil:
		return "UNAVAILABLE", 0
	case v.Muted:
		return "MUTED", 0
	case v.RetryAfterMS > 0:
		return "SLOW_MODE", v.RetryAfterMS
	}
	return "", 0
}

func writeSlowMode(ctx context.Context, c *websocket.Conn, ref string, retryAfterMS int64) {
	raw, _ := json.Marshal(socialevent.ErrorEnvelope{
		Type: socialevent.TypeError, Code: "SLOW_MODE", EventIDRef: ref, RetryAfterMS: retryAfterMS,
	})
	_ = writeMsg(ctx, c, raw, DefaultWriteTimeout)
}
