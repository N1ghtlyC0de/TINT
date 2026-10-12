package telemetry

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

var at = time.Date(2026, 10, 10, 18, 0, 0, 0, time.UTC)

const clientEventID = "6f1c2a8e-8a4e-4d0a-9f5b-1c2d3e4f5a6b"

func sample() DriftSample {
	return DriftSample{RoomID: "r1", DriftMs: -820, RTTMs: 60, Strategy: "rate", Role: "participant", PositionMs: 61_000, OccurredAt: at, ReceivedAt: at.Add(30 * time.Millisecond)}
}

// emitAndRead ejecuta emit con un Emitter conectado a miniredis y devuelve
// los campos del único mensaje escrito en el stream.
func emitAndRead(t *testing.T, emit func(*Emitter) bool) map[string]any {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	e := New(rdb, 8)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.Run(ctx); close(done) }()

	if !emit(e) {
		t.Fatal("con buffer libre la emisión debe aceptarse")
	}

	var msgs []redis.XMessage
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		msgs, _ = rdb.XRange(context.Background(), StreamKey, "-", "+").Result()
		if len(msgs) == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if len(msgs) != 1 {
		t.Fatalf("mensajes en %s = %d", StreamKey, len(msgs))
	}
	v := msgs[0].Values
	// Sin PII: sync-core nunca envía sub, nick ni user_id (usa role).
	for _, k := range []string{"sub", "nick", "user_id"} {
		if _, ok := v[k]; ok {
			t.Errorf("no se debe enviar PII (%s)", k)
		}
	}
	return v
}

func expectFields(t *testing.T, v map[string]any, want map[string]string) {
	t.Helper()
	for k, w := range want {
		if v[k] != w {
			t.Errorf("%s = %v, want %s", k, v[k], w)
		}
	}
}

func TestEmitDriftIsWrittenToStream(t *testing.T) {
	v := emitAndRead(t, func(e *Emitter) bool { return e.EmitDrift(sample()) })
	// Campos del contrato de analytics:events (docs/contrato-eventos-analitica.md);
	// fechas RFC 3339 UTC con milisegundos.
	expectFields(t, v, map[string]string{
		"type": "drift_correction", "source": "sync-core", "room_id": "r1",
		"occurred_at": "2026-10-10T18:00:00.000Z", "received_at": "2026-10-10T18:00:00.030Z",
		"drift_ms": "-820", "rtt_ms": "60", "strategy": "rate", "role": "participant", "position_ms": "61000",
	})
	if id, _ := v["event_id"].(string); len(id) != 36 {
		t.Errorf("event_id debe ser UUID, got %v", v["event_id"])
	}
}

func TestEmitPlaybackReusesCommandEventID(t *testing.T) {
	v := emitAndRead(t, func(e *Emitter) bool {
		return e.EmitPlayback(PlaybackSample{
			EventID: clientEventID, RoomID: "r1", Command: "SEEK", PositionMs: 90_500, Role: "host",
			OccurredAt: at.Add(-2 * time.Second), ReceivedAt: at.Add(1500 * time.Microsecond),
		})
	})
	expectFields(t, v, map[string]string{
		"event_id": clientEventID, "type": "playback_command", "source": "sync-core", "room_id": "r1",
		"command": "SEEK", "position_ms": "90500", "role": "host",
		"occurred_at": "2026-10-10T17:59:58.000Z", "received_at": "2026-10-10T18:00:00.001Z",
	})
}

func TestEmitBufferingIsWrittenToStream(t *testing.T) {
	v := emitAndRead(t, func(e *Emitter) bool {
		return e.EmitBuffering(BufferingSample{
			EventID: clientEventID, RoomID: "r1", DurationMs: 850, PositionMs: 12_345, Role: "participant",
			OccurredAt: at, ReceivedAt: at.Add(20 * time.Millisecond),
		})
	})
	expectFields(t, v, map[string]string{
		"event_id": clientEventID, "type": "buffering", "source": "sync-core", "room_id": "r1",
		"duration_ms": "850", "position_ms": "12345", "role": "participant",
		"occurred_at": "2026-10-10T18:00:00.000Z", "received_at": "2026-10-10T18:00:00.020Z",
	})
}

// Un event_id del cliente que no es UUID no llega a analytics (su clave
// primaria es UUID): se genera uno nuevo. Uno válido se normaliza.
func TestEventIDFallsBackToUUID(t *testing.T) {
	if got := eventID("e-play"); len(got) != 36 || got == "e-play" {
		t.Errorf("eventID(no UUID) = %q, want UUID nuevo", got)
	}
	if got := eventID("6F1C2A8E-8A4E-4D0A-9F5B-1C2D3E4F5A6B"); got != clientEventID {
		t.Errorf("eventID(UUID) = %q, want %q", got, clientEventID)
	}
}

// Con el buffer lleno ninguna emisión bloquea al canal sync: descarta y cuenta.
func TestEmitNeverBlocks(t *testing.T) {
	e := New(nil, 1) // sin Run: nadie consume
	if !e.EmitDrift(sample()) {
		t.Fatal("el primero cabe en el buffer")
	}
	start := time.Now()
	for i := 0; i < 100; i++ {
		if e.EmitDrift(sample()) || e.EmitPlayback(PlaybackSample{}) || e.EmitBuffering(BufferingSample{}) {
			t.Fatal("con buffer lleno debe descartar")
		}
	}
	if time.Since(start) > 50*time.Millisecond {
		t.Error("la emisión bloqueó")
	}
	if e.Dropped() != 300 {
		t.Errorf("Dropped = %d, want 300", e.Dropped())
	}
}

func TestRunCountsFailures(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1})
	defer rdb.Close()
	mr.Close() // Redis caído

	e := New(rdb, 4)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.Run(ctx); close(done) }()
	e.EmitDrift(sample())

	deadline := time.Now().Add(2 * time.Second)
	for e.Failed() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if e.Failed() != 1 {
		t.Errorf("Failed = %d, want 1", e.Failed())
	}
}
