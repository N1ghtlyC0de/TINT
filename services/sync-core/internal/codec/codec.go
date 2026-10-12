// Package codec serializa los mensajes del Canal Sync. JSON es el formato
// por defecto; MessagePack es opcional y se negocia con el subprotocolo
// WebSocket "tint.sync.msgpack". Ambos usan las mismas claves y los
// timestamps viajan como string ISO-8601 en los dos formatos, así el
// cliente comparte el mismo modelo de datos.
package codec

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// Subprotocolos WebSocket aceptados, en orden de preferencia del servidor.
const (
	SubprotocolMsgPack = "tint.sync.msgpack"
	SubprotocolJSON    = "tint.sync.json"
)

// Subprotocols se pasa a websocket.Accept.
var Subprotocols = []string{SubprotocolMsgPack, SubprotocolJSON}

// Codec codifica y decodifica eventos del canal.
type Codec interface {
	Name() string
	Binary() bool // true → frames binarios; false → texto
	Encode(syncevent.Event) ([]byte, error)
	Decode([]byte, *syncevent.Event) error
}

var (
	JSON    Codec = jsonCodec{}
	MsgPack Codec = msgpackCodec{}
)

// ForSubprotocol devuelve el códec del subprotocolo negociado (JSON si no hubo).
func ForSubprotocol(p string) Codec {
	if p == SubprotocolMsgPack {
		return MsgPack
	}
	return JSON
}

type jsonCodec struct{}

func (jsonCodec) Name() string                                 { return "json" }
func (jsonCodec) Binary() bool                                 { return false }
func (jsonCodec) Encode(ev syncevent.Event) ([]byte, error)    { return json.Marshal(ev) }
func (jsonCodec) Decode(raw []byte, ev *syncevent.Event) error { return json.Unmarshal(raw, ev) }

type msgpackCodec struct{}

func (msgpackCodec) Name() string { return "msgpack" }
func (msgpackCodec) Binary() bool { return true }

func (msgpackCodec) Encode(ev syncevent.Event) ([]byte, error) {
	return msgpack.Marshal(toWire(ev))
}

func (msgpackCodec) Decode(raw []byte, ev *syncevent.Event) error {
	var w wire
	if err := msgpack.Unmarshal(raw, &w); err != nil {
		return err
	}
	out, err := fromWire(w)
	if err != nil {
		return err
	}
	*ev = out
	return nil
}

// wire refleja syncevent.Event con los timestamps como string, igual que
// en JSON (las claves y omitempty coinciden con las etiquetas json).
type wire struct {
	EventID      string   `msgpack:"event_id"`
	Type         string   `msgpack:"type"`
	RoomID       string   `msgpack:"room_id"`
	PositionMs   int64    `msgpack:"position_ms"`
	OccurredAt   string   `msgpack:"occurred_at"`
	ReceivedAt   string   `msgpack:"received_at"`
	Version      int64    `msgpack:"version"`
	Status       string   `msgpack:"status,omitempty"`
	Rate         float64  `msgpack:"rate,omitempty"`
	UpdatedAtMs  int64    `msgpack:"updated_at_ms,omitempty"`
	ServerTimeMs int64    `msgpack:"server_time_ms,omitempty"`
	EchoServerTs int64    `msgpack:"echo_server_ts,omitempty"`
	TargetMs     *int64   `msgpack:"target_ms,omitempty"`
	Strategy     string   `msgpack:"strategy,omitempty"`
	DriftMs      int64    `msgpack:"drift_ms,omitempty"`
	Online       *bool    `msgpack:"online,omitempty"`
	RefEventID   string   `msgpack:"ref_event_id,omitempty"`
	Code         string   `msgpack:"code,omitempty"`
	Duplicate    bool     `msgpack:"duplicate,omitempty"`
	MediaID      string   `msgpack:"media_id,omitempty"`
	Volume       *float64 `msgpack:"volume,omitempty"`
	Quality      string   `msgpack:"quality,omitempty"`
	RTTMs        int64    `msgpack:"rtt_ms,omitempty"`
	CanControl   *bool    `msgpack:"can_control,omitempty"`
	Holder       string   `msgpack:"holder,omitempty"`
	JTI          string   `msgpack:"jti,omitempty"`
	DurationMs   int64    `msgpack:"duration_ms,omitempty"`
}

func toWire(e syncevent.Event) wire {
	return wire{
		EventID: e.EventID, Type: string(e.Type), RoomID: e.RoomID, PositionMs: e.PositionMs,
		OccurredAt: formatTime(e.OccurredAt), ReceivedAt: formatTime(e.ReceivedAt), Version: e.Version,
		Status: e.Status, Rate: e.Rate, UpdatedAtMs: e.UpdatedAtMs, ServerTimeMs: e.ServerTimeMs,
		EchoServerTs: e.EchoServerTs, TargetMs: e.TargetMs, Strategy: e.Strategy, DriftMs: e.DriftMs,
		Online: e.Online, RefEventID: e.RefEventID, Code: e.Code, Duplicate: e.Duplicate,
		MediaID: e.MediaID, RTTMs: e.RTTMs, CanControl: e.CanControl, Holder: e.Holder, JTI: e.JTI,
		Volume: e.Volume, Quality: e.Quality, DurationMs: e.DurationMs,
	}
}

func fromWire(w wire) (syncevent.Event, error) {
	occurred, err := parseTime(w.OccurredAt)
	if err != nil {
		return syncevent.Event{}, fmt.Errorf("occurred_at: %w", err)
	}
	received, err := parseTime(w.ReceivedAt)
	if err != nil {
		return syncevent.Event{}, fmt.Errorf("received_at: %w", err)
	}
	return syncevent.Event{
		EventID: w.EventID, Type: syncevent.Type(w.Type), RoomID: w.RoomID, PositionMs: w.PositionMs,
		OccurredAt: occurred, ReceivedAt: received, Version: w.Version,
		Status: w.Status, Rate: w.Rate, UpdatedAtMs: w.UpdatedAtMs, ServerTimeMs: w.ServerTimeMs,
		EchoServerTs: w.EchoServerTs, TargetMs: w.TargetMs, Strategy: w.Strategy, DriftMs: w.DriftMs,
		Online: w.Online, RefEventID: w.RefEventID, Code: w.Code, Duplicate: w.Duplicate,
		MediaID: w.MediaID, RTTMs: w.RTTMs, CanControl: w.CanControl, Holder: w.Holder, JTI: w.JTI,
		Volume: w.Volume, Quality: w.Quality, DurationMs: w.DurationMs,
	}, nil
}

// formatTime usa el mismo formato que encoding/json para time.Time.
func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339Nano)
}

func parseTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339Nano, s)
}
