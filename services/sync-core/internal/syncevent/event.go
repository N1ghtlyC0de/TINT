// Package syncevent modela los mensajes que viajan por /ws/sync.
package syncevent

import (
	"errors"
	"fmt"
	"time"
)

// Type es el tipo de mensaje del canal de sincronización.
type Type string

const (
	// Comandos del Host (cliente → servidor y broadcast servidor → clientes).
	Play  Type = "PLAY"
	Pause Type = "PAUSE"
	Seek  Type = "SEEK"

	// Latido servidor → cliente; el cliente responde con SYNC_CHECK.
	Heartbeat Type = "HEARTBEAT"
	SyncCheck Type = "SYNC_CHECK"

	// Mensajes servidor → cliente.
	State          Type = "STATE"
	SyncCorrection Type = "SYNC_CORRECTION"
	HostStatus     Type = "HOST_STATUS"
	Ack            Type = "ACK"
	Error          Type = "ERROR"
)

// Códigos de error enviados en mensajes ERROR.
const (
	CodeForbidden   = "FORBIDDEN"
	CodeInvalid     = "INVALID"
	CodeRateLimited = "RATE_LIMITED"
	CodeInternal    = "INTERNAL"
)

// Event es el payload transmitido por el canal de sincronización. Los campos
// opcionales se omiten cuando no aplican al tipo de mensaje.
type Event struct {
	EventID    string    `json:"event_id"`
	Type       Type      `json:"type"`
	RoomID     string    `json:"room_id"`
	PositionMs int64     `json:"position_ms"`
	OccurredAt time.Time `json:"occurred_at"`
	ReceivedAt time.Time `json:"received_at"`
	Version    int64     `json:"version"`

	// Ancla del Reloj Maestro (STATE y broadcasts de comandos).
	Status       string  `json:"status,omitempty"`
	Rate         float64 `json:"rate,omitempty"`
	UpdatedAtMs  int64   `json:"updated_at_ms,omitempty"`
	ServerTimeMs int64   `json:"server_time_ms,omitempty"`

	// Medición de RTT y drift.
	EchoServerTs int64  `json:"echo_server_ts,omitempty"`
	TargetMs     *int64 `json:"target_ms,omitempty"`
	Strategy     string `json:"strategy,omitempty"`
	DriftMs      int64  `json:"drift_ms,omitempty"`

	// Presencia del Host, confirmaciones y errores.
	Online     *bool  `json:"online,omitempty"`
	RefEventID string `json:"ref_event_id,omitempty"`
	Code       string `json:"code,omitempty"`
	Duplicate  bool   `json:"duplicate,omitempty"`
}

var (
	ErrMissingEventID   = errors.New("event_id es obligatorio")
	ErrMissingRoomID    = errors.New("room_id es obligatorio")
	ErrUnsupportedType  = errors.New("tipo de evento no soportado en /ws/sync")
	ErrMissingTimestamp = errors.New("occurred_at y received_at son obligatorios")
	ErrNegativePosition = errors.New("position_ms no puede ser negativo")
	ErrReceivedBefore   = errors.New("received_at no puede ser anterior a occurred_at")
)

// Validate verifica que un evento completo (ya sellado por el servidor)
// cumpla el contrato del canal de sync.
func (e Event) Validate() error {
	if err := e.validateBase(); err != nil {
		return err
	}
	switch e.Type {
	case Play, Pause, Seek, Heartbeat, SyncCheck, State, SyncCorrection, HostStatus, Ack, Error:
	default:
		return fmt.Errorf("%w: %q", ErrUnsupportedType, e.Type)
	}
	if e.OccurredAt.IsZero() || e.ReceivedAt.IsZero() {
		return ErrMissingTimestamp
	}
	if e.ReceivedAt.Before(e.OccurredAt) {
		return ErrReceivedBefore
	}
	return nil
}

// ValidateInbound verifica un mensaje enviado por un cliente. No compara
// occurred_at con received_at: son relojes distintos y el del cliente puede
// estar adelantado; esa diferencia se audita, no se rechaza.
func (e Event) ValidateInbound() error {
	if err := e.validateBase(); err != nil {
		return err
	}
	switch e.Type {
	case Play, Pause, Seek, SyncCheck:
	default:
		return fmt.Errorf("%w: %q", ErrUnsupportedType, e.Type)
	}
	if e.OccurredAt.IsZero() {
		return ErrMissingTimestamp
	}
	return nil
}

func (e Event) validateBase() error {
	if e.EventID == "" {
		return ErrMissingEventID
	}
	if e.RoomID == "" {
		return ErrMissingRoomID
	}
	if e.PositionMs < 0 {
		return ErrNegativePosition
	}
	return nil
}

// IsCommand indica si el evento es un comando de reproducción del Host.
func (e Event) IsCommand() bool {
	return e.Type == Play || e.Type == Pause || e.Type == Seek
}

// Latency devuelve el tiempo de tránsito del evento.
func (e Event) Latency() time.Duration {
	return e.ReceivedAt.Sub(e.OccurredAt)
}

// StateKey devuelve la clave Redis del estado maestro de una sala.
func StateKey(roomID string) string {
	return "room:" + roomID + ":sync_state"
}

// EventKey devuelve la clave de idempotencia de un event_id.
func EventKey(roomID, eventID string) string {
	return "room:" + roomID + ":evt:" + eventID
}

// ChannelKey devuelve el canal Pub/Sub de la sala entre réplicas.
func ChannelKey(roomID string) string {
	return "room:" + roomID + ":sync"
}

// HostsKey devuelve el set de conexiones de host/co-host activas.
func HostsKey(roomID string) string {
	return "room:" + roomID + ":hosts_online"
}

// Int64 y Bool crean punteros para campos opcionales donde el cero es válido.
func Int64(v int64) *int64 { return &v }
func Bool(v bool) *bool    { return &v }
