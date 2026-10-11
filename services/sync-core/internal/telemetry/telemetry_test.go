package telemetry

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

var at = time.Date(2026, 10, 10, 18, 0, 0, 0, time.UTC)

func sample() DriftSample {
	return DriftSample{RoomID: "r1", DriftMs: -820, RTTMs: 60, Strategy: "rate", Role: "participant", OccurredAt: at, ReceivedAt: at.Add(30 * time.Millisecond)}
}

func TestEmitDriftIsWrittenToStream(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	e := New(rdb, 8)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.Run(ctx); close(done) }()

	if !e.EmitDrift(sample()) {
		t.Fatal("EmitDrift debe aceptar con buffer libre")
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
	// Campos obligatorios de services/analytics (REQUIRED_FIELDS) y sin PII.
	for k, want := range map[string]string{
		"type": "sync_drift", "room_id": "r1", "occurred_at": "2026-10-10T18:00:00Z",
		"received_at": "2026-10-10T18:00:00.03Z", "drift_ms": "-820", "rtt_ms": "60",
		"strategy": "rate", "role": "participant",
	} {
		if v[k] != want {
			t.Errorf("%s = %v, want %s", k, v[k], want)
		}
	}
	if id, _ := v["event_id"].(string); len(id) != 36 {
		t.Errorf("event_id debe ser UUID, got %v", v["event_id"])
	}
	for _, k := range []string{"sub", "nick", "user_id"} {
		if _, ok := v[k]; ok {
			t.Errorf("no se debe enviar PII (%s)", k)
		}
	}
}

// Con el buffer lleno EmitDrift nunca bloquea al canal sync: descarta y cuenta.
func TestEmitDriftNeverBlocks(t *testing.T) {
	e := New(nil, 1) // sin Run: nadie consume
	if !e.EmitDrift(sample()) {
		t.Fatal("el primero cabe en el buffer")
	}
	start := time.Now()
	for i := 0; i < 100; i++ {
		if e.EmitDrift(sample()) {
			t.Fatal("con buffer lleno debe descartar")
		}
	}
	if time.Since(start) > 50*time.Millisecond {
		t.Error("EmitDrift bloqueó")
	}
	if e.Dropped() != 100 {
		t.Errorf("Dropped = %d, want 100", e.Dropped())
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
