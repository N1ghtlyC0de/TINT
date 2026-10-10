package syncevent

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func validEvent() Event {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	return Event{
		EventID:    "6f1c2a8e-8a4e-4d0a-9f5b-1c2d3e4f5a6b",
		Type:       Play,
		RoomID:     "room-1",
		PositionMs: 1500,
		OccurredAt: now,
		ReceivedAt: now.Add(40 * time.Millisecond),
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Event)
		want   error
	}{
		{"valid play", func(*Event) {}, nil},
		{"valid pause", func(e *Event) { e.Type = Pause }, nil},
		{"valid seek", func(e *Event) { e.Type = Seek }, nil},
		{"valid heartbeat", func(e *Event) { e.Type = Heartbeat }, nil},
		{"valid state", func(e *Event) { e.Type = State }, nil},
		{"valid sync check", func(e *Event) { e.Type = SyncCheck }, nil},
		{"valid correction", func(e *Event) { e.Type = SyncCorrection }, nil},
		{"valid host status", func(e *Event) { e.Type = HostStatus }, nil},
		{"valid ack", func(e *Event) { e.Type = Ack }, nil},
		{"valid error", func(e *Event) { e.Type = Error }, nil},
		{"missing id", func(e *Event) { e.EventID = "" }, ErrMissingEventID},
		{"missing room", func(e *Event) { e.RoomID = "" }, ErrMissingRoomID},
		{"chat not allowed", func(e *Event) { e.Type = "CHAT" }, ErrUnsupportedType},
		{"missing occurred_at", func(e *Event) { e.OccurredAt = time.Time{} }, ErrMissingTimestamp},
		{"missing received_at", func(e *Event) { e.ReceivedAt = time.Time{} }, ErrMissingTimestamp},
		{"received before occurred", func(e *Event) { e.ReceivedAt = e.OccurredAt.Add(-time.Second) }, ErrReceivedBefore},
		{"negative position", func(e *Event) { e.PositionMs = -1 }, ErrNegativePosition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := validEvent()
			tt.mutate(&e)
			if err := e.Validate(); !errors.Is(err, tt.want) {
				t.Errorf("Validate() = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestLatency(t *testing.T) {
	if got := validEvent().Latency(); got != 40*time.Millisecond {
		t.Errorf("Latency() = %v, want 40ms", got)
	}
}

func TestStateKey(t *testing.T) {
	if got := StateKey("abc"); got != "room:abc:sync_state" {
		t.Errorf("StateKey() = %q", got)
	}
}

func TestValidateInbound(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Event)
		want   error
	}{
		{"play", func(*Event) {}, nil},
		{"sync check", func(e *Event) { e.Type = SyncCheck }, nil},
		// El reloj del cliente puede ir adelantado: no se comparan relojes distintos.
		{"cliente con reloj adelantado", func(e *Event) { e.ReceivedAt = e.OccurredAt.Add(-time.Hour) }, nil},
		{"received_at aún no asignado", func(e *Event) { e.ReceivedAt = time.Time{} }, nil},
		{"el cliente no emite STATE", func(e *Event) { e.Type = State }, ErrUnsupportedType},
		{"el cliente no emite HEARTBEAT", func(e *Event) { e.Type = Heartbeat }, ErrUnsupportedType},
		{"chat", func(e *Event) { e.Type = "CHAT" }, ErrUnsupportedType},
		{"missing id", func(e *Event) { e.EventID = "" }, ErrMissingEventID},
		{"missing room", func(e *Event) { e.RoomID = "" }, ErrMissingRoomID},
		{"missing occurred_at", func(e *Event) { e.OccurredAt = time.Time{} }, ErrMissingTimestamp},
		{"negative position", func(e *Event) { e.PositionMs = -5 }, ErrNegativePosition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := validEvent()
			tt.mutate(&e)
			if err := e.ValidateInbound(); !errors.Is(err, tt.want) {
				t.Errorf("ValidateInbound() = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestIsCommand(t *testing.T) {
	for _, typ := range []Type{Play, Pause, Seek} {
		if !(Event{Type: typ}).IsCommand() {
			t.Errorf("%s debe ser comando", typ)
		}
	}
	for _, typ := range []Type{SyncCheck, Heartbeat, State, Ack} {
		if (Event{Type: typ}).IsCommand() {
			t.Errorf("%s no debe ser comando", typ)
		}
	}
}

func TestKeys(t *testing.T) {
	if got := EventKey("abc", "e1"); got != "room:abc:evt:e1" {
		t.Errorf("EventKey() = %q", got)
	}
	if got := ChannelKey("abc"); got != "room:abc:sync" {
		t.Errorf("ChannelKey() = %q", got)
	}
	if got := HostsKey("abc"); got != "room:abc:hosts_online" {
		t.Errorf("HostsKey() = %q", got)
	}
}

func TestJSONContract(t *testing.T) {
	e := validEvent()
	e.Type = SyncCorrection
	e.TargetMs = Int64(0) // seek al inicio: el 0 debe viajar explícito
	e.Strategy = "seek"
	e.DriftMs = -900
	raw, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"event_id", "type", "room_id", "position_ms", "occurred_at", "received_at", "version", "target_ms", "strategy", "drift_ms"} {
		if _, ok := m[k]; !ok {
			t.Errorf("falta el campo %q en %s", k, raw)
		}
	}
	for _, k := range []string{"online", "code", "ref_event_id", "echo_server_ts", "duplicate"} {
		if _, ok := m[k]; ok {
			t.Errorf("el campo vacío %q no debe serializarse: %s", k, raw)
		}
	}
	if Bool(true) == nil || !*Bool(true) {
		t.Error("Bool helper")
	}
}
