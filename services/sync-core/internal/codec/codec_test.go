package codec

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

func sample() syncevent.Event {
	at := time.Date(2026, 10, 10, 18, 0, 0, 123_000_000, time.UTC)
	return syncevent.Event{
		EventID: "6f1c2a8e-8a4e-4d0a-9f5b-1c2d3e4f5a6b", Type: syncevent.Play, RoomID: "room-1",
		PositionMs: 61_000, OccurredAt: at, ReceivedAt: at.Add(40 * time.Millisecond), Version: 42,
		Status: "playing", Rate: 1.25, UpdatedAtMs: 1_791_655_200_160, ServerTimeMs: 1_791_655_200_160,
		TargetMs: syncevent.Int64(0), Online: syncevent.Bool(false), CanControl: syncevent.Bool(true),
		MediaID: "m-1", RTTMs: 35, DriftMs: -620, Strategy: "rate",
	}
}

func TestRoundTrip(t *testing.T) {
	for _, c := range []Codec{JSON, MsgPack} {
		t.Run(c.Name(), func(t *testing.T) {
			raw, err := c.Encode(sample())
			if err != nil {
				t.Fatal(err)
			}
			var got syncevent.Event
			if err := c.Decode(raw, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, sample()) {
				t.Errorf("ida y vuelta =\n %+v\nwant\n %+v", got, sample())
			}
		})
	}
}

// El contrato: mismas claves que el JSON, timestamps como string ISO-8601 y
// campos vacíos omitidos (los punteros con cero/false sí viajan).
func TestMsgPackMatchesJSONShape(t *testing.T) {
	ev := sample()
	ev.Online = nil
	ev.DriftMs = 0
	rawJSON, _ := JSON.Encode(ev)
	var fromJSON map[string]any
	_ = json.Unmarshal(rawJSON, &fromJSON)

	rawMP, err := MsgPack.Encode(ev)
	if err != nil {
		t.Fatal(err)
	}
	var fromMP map[string]any
	if err := msgpack.Unmarshal(rawMP, &fromMP); err != nil {
		t.Fatal(err)
	}
	if len(fromMP) != len(fromJSON) {
		t.Errorf("claves msgpack %v\nvs json %v", keys(fromMP), keys(fromJSON))
	}
	for k := range fromJSON {
		if _, ok := fromMP[k]; !ok {
			t.Errorf("falta %q en msgpack", k)
		}
	}
	if fromMP["occurred_at"] != "2026-10-10T18:00:00.123Z" {
		t.Errorf("occurred_at = %#v, debe ser string ISO", fromMP["occurred_at"])
	}
	if fromMP["can_control"] != true {
		t.Errorf("can_control = %#v", fromMP["can_control"])
	}
	if len(rawMP) >= len(rawJSON) {
		t.Errorf("msgpack (%d B) debe ser más compacto que JSON (%d B)", len(rawMP), len(rawJSON))
	}
}

func keys(m map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestDecodeErrors(t *testing.T) {
	var ev syncevent.Event
	if err := MsgPack.Decode([]byte{0xc1}, &ev); err == nil {
		t.Error("msgpack inválido")
	}
	bad, _ := msgpack.Marshal(map[string]any{"event_id": "x", "occurred_at": "ayer"})
	if err := MsgPack.Decode(bad, &ev); err == nil {
		t.Error("timestamp inválido")
	}
	bad, _ = msgpack.Marshal(map[string]any{"event_id": "x", "received_at": "ayer"})
	if err := MsgPack.Decode(bad, &ev); err == nil {
		t.Error("received_at inválido")
	}
	if err := JSON.Decode([]byte("{"), &ev); err == nil {
		t.Error("json inválido")
	}
	// Timestamps ausentes quedan en cero (la validación los rechaza después).
	empty, _ := msgpack.Marshal(map[string]any{"event_id": "x"})
	if err := MsgPack.Decode(empty, &ev); err != nil || !ev.OccurredAt.IsZero() {
		t.Errorf("sin timestamps: %v %v", err, ev.OccurredAt)
	}
}

func TestForSubprotocol(t *testing.T) {
	if ForSubprotocol(SubprotocolMsgPack) != MsgPack || ForSubprotocol(SubprotocolJSON) != JSON || ForSubprotocol("") != JSON {
		t.Error("selección de códec")
	}
	if JSON.Binary() || !MsgPack.Binary() {
		t.Error("Binary()")
	}
	if len(Subprotocols) != 2 || Subprotocols[0] != SubprotocolMsgPack {
		t.Errorf("Subprotocols = %v", Subprotocols)
	}
}

func BenchmarkDecode(b *testing.B) {
	ev := sample()
	for _, c := range []Codec{JSON, MsgPack} {
		b.Run(c.Name(), func(b *testing.B) {
			raw, _ := c.Encode(ev)
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				var out syncevent.Event
				if err := c.Decode(raw, &out); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkEncode(b *testing.B) {
	ev := sample()
	for _, c := range []Codec{JSON, MsgPack} {
		b.Run(c.Name(), func(b *testing.B) {
			raw, _ := c.Encode(ev)
			b.ReportMetric(float64(len(raw)), "bytes/msg")
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_, _ = c.Encode(ev)
			}
		})
	}
}
