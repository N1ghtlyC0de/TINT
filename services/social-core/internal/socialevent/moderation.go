package socialevent

import "errors"

// Moderación del chat: el host o cohost activa el modo lento y silencia a
// participantes; el estado viaja como chat_settings.
const (
	TypeChatSlowMode Type = "chat_slow_mode"
	TypeChatMute     Type = "chat_mute"
	TypeChatSettings Type = "chat_settings"
)

// MaxUserIDRunes acota el user_id de un chat_mute.
const MaxUserIDRunes = 128

var (
	ErrInvalidSlowMode = errors.New("seconds debe ser 0, 5, 10, 30 o 60")
	ErrMissingMuted    = errors.New("muted es obligatorio")
)

// slowModes son los valores aceptados de seconds.
var slowModes = [...]int{0, 5, 10, 30, 60}

// ChatSlowMode fija el modo lento de la sala (0 = apagado).
type ChatSlowMode struct {
	EventID string `json:"event_id"`
	Type    Type   `json:"type"`
	RoomID  string `json:"room_id"`
	Seconds *int   `json:"seconds"`
}

// Validate verifica un chat_slow_mode.
func (m ChatSlowMode) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeChatSlowMode {
		return ErrUnsupportedType
	}
	if m.Seconds == nil {
		return ErrInvalidSlowMode
	}
	for _, s := range slowModes {
		if *m.Seconds == s {
			return nil
		}
	}
	return ErrInvalidSlowMode
}

// ChatMute silencia (o quita el silencio a) un participante.
type ChatMute struct {
	EventID string `json:"event_id"`
	Type    Type   `json:"type"`
	RoomID  string `json:"room_id"`
	UserID  string `json:"user_id"`
	Muted   *bool  `json:"muted"`
}

// Validate verifica un chat_mute.
func (m ChatMute) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeChatMute {
		return ErrUnsupportedType
	}
	if !runesBetween(trim(m.UserID), 1, MaxUserIDRunes) {
		return ErrMissingUser
	}
	if m.Muted == nil {
		return ErrMissingMuted
	}
	return nil
}

// ChatSettings es el estado de moderación del chat (broadcast y al entrar).
type ChatSettings struct {
	EventID      string   `json:"event_id"`
	Type         Type     `json:"type"`
	RoomID       string   `json:"room_id"`
	SlowModeS    int      `json:"slow_mode_s"`
	MutedUserIDs []string `json:"muted_user_ids"`
}
