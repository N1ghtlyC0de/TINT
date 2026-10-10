// Package telemetry publica métricas del canal sync en el stream
// analytics:events sin bloquear nunca el tráfico de reproducción (REQ-29).
//
// EmitDrift solo encola en un canal con buffer; una goroutine aparte hace
// XADD. Si el buffer está lleno (Redis lento o caído) el evento se descarta
// y se cuenta: perder una métrica es preferible a frenar el video.
package telemetry

import (
	"context"
	"log"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	// StreamKey es el stream consumido por services/analytics (XREADGROUP).
	StreamKey = "analytics:events"
	maxLen    = 100_000
)

// DriftSample es un desfase > 500 ms detectado en un cliente (REQ-28).
// No contiene identidad del usuario (Privacy by Design, Ley 1581).
type DriftSample struct {
	RoomID     string
	DriftMs    int64
	RTTMs      int64
	Strategy   string
	Role       string
	OccurredAt time.Time // reloj del cliente
	ReceivedAt time.Time // reloj del servidor
}

// Emitter encola y escribe eventos de telemetría.
type Emitter struct {
	rdb     redis.Cmdable
	ch      chan map[string]any
	dropped atomic.Int64
	failed  atomic.Int64
}

// New crea un Emitter con un buffer de tamaño buffer.
func New(rdb redis.Cmdable, buffer int) *Emitter {
	return &Emitter{rdb: rdb, ch: make(chan map[string]any, buffer)}
}

// EmitDrift encola la muestra sin bloquear. Devuelve false si se descartó.
func (e *Emitter) EmitDrift(s DriftSample) bool {
	ev := map[string]any{
		"event_id":    uuid.NewString(),
		"type":        "sync_drift",
		"room_id":     s.RoomID,
		"occurred_at": s.OccurredAt.UTC().Format(time.RFC3339Nano),
		"received_at": s.ReceivedAt.UTC().Format(time.RFC3339Nano),
		"drift_ms":    s.DriftMs,
		"rtt_ms":      s.RTTMs,
		"strategy":    s.Strategy,
		"role":        s.Role,
	}
	select {
	case e.ch <- ev:
		return true
	default:
		e.dropped.Add(1)
		return false
	}
}

// Run escribe los eventos encolados hasta que ctx se cancele.
func (e *Emitter) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-e.ch:
			err := e.rdb.XAdd(ctx, &redis.XAddArgs{Stream: StreamKey, MaxLen: maxLen, Approx: true, Values: ev}).Err()
			if err != nil {
				e.failed.Add(1)
				log.Printf("telemetry: XADD falló: %v", err)
			}
		}
	}
}

// Dropped devuelve cuántos eventos se descartaron por buffer lleno.
func (e *Emitter) Dropped() int64 { return e.dropped.Load() }

// Failed devuelve cuántos XADD fallaron.
func (e *Emitter) Failed() int64 { return e.failed.Load() }
