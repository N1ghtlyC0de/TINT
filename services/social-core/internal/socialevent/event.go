// Package socialevent modela el contrato del Canal Social (/ws/social) para chat.
package socialevent

import (
	"errors"
	"time"
	"unicode/utf8"
)

// Tipos de mensaje que viajan por /ws/social (solo chat en este alcance).
type Type string

const (
	TypeChatSend    Type = "chat_send"
	TypeChatMessage Type = "chat_message"
	TypeHistory     Type = "history"
	TypeError       Type = "error"
)

// MaxTextRunes es el largo máximo de un mensaje de chat (regla de producto).
const MaxTextRunes = 280

// HistoryLimit es el historial corto por sala.
const HistoryLimit = 50

var (
	ErrMissingEventID   = errors.New("event_id es obligatorio")
	ErrUnsupportedType  = errors.New("tipo de evento no soportado en /ws/social")
	ErrMissingRoom      = errors.New("room_id es obligatorio")
	ErrEmptyText        = errors.New("text no puede estar vacío")
	ErrTextTooLong      = errors.New("text supera los 280 caracteres")
	ErrMissingTimestamp = errors.New("occurred_at es obligatorio")
	ErrReceivedBefore   = errors.New("received_at no puede ser anterior a occurred_at")
)

// ChatSend es el mensaje que envía el cliente.
type ChatSend struct {
	EventID    string    `json:"event_id"`
	Type       Type      `json:"type"`
	RoomID     string    `json:"room_id"`
	Text       string    `json:"text"`
	OccurredAt time.Time `json:"occurred_at"`
}

// Validate verifica el contrato de un chat_send.
func (m ChatSend) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeChatSend {
		return ErrUnsupportedType
	}
	if m.RoomID == "" {
		return ErrMissingRoom
	}
	if length := utf8.RuneCountInString(trim(m.Text)); length == 0 {
		return ErrEmptyText
	} else if length > MaxTextRunes {
		return ErrTextTooLong
	}
	if m.OccurredAt.IsZero() {
		return ErrMissingTimestamp
	}
	return nil
}

// ChatMessage es el broadcast del servidor.
type ChatMessage struct {
	EventID    string    `json:"event_id"`
	Type       Type      `json:"type"`
	RoomID     string    `json:"room_id"`
	UserID     string    `json:"user_id"`
	Nick       string    `json:"nick"`
	Text       string    `json:"text"`
	OccurredAt time.Time `json:"occurred_at"`
	ReceivedAt time.Time `json:"received_at"`
}

// Validate verifica un chat_message.
func (m ChatMessage) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeChatMessage {
		return ErrUnsupportedType
	}
	if m.RoomID == "" {
		return ErrMissingRoom
	}
	if length := utf8.RuneCountInString(trim(m.Text)); length == 0 {
		return ErrEmptyText
	} else if length > MaxTextRunes {
		return ErrTextTooLong
	}
	if m.OccurredAt.IsZero() || m.ReceivedAt.IsZero() {
		return ErrMissingTimestamp
	}
	if m.ReceivedAt.Before(m.OccurredAt) {
		return ErrReceivedBefore
	}
	return nil
}

// HistoryEnvelope es el historial corto enviado al hacer join.
type HistoryEnvelope struct {
	Type     Type          `json:"type"`
	RoomID   string        `json:"room_id"`
	Messages []ChatMessage `json:"messages"`
}

// ErrorEnvelope es un error dirigido a un cliente.
type ErrorEnvelope struct {
	Type       Type   `json:"type"`
	Code       string `json:"code"`
	EventIDRef string `json:"event_id_ref,omitempty"`
}

func trim(s string) string {
	// Trim mínimo sin importar unicode/strings para mensajes con espacios.
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
