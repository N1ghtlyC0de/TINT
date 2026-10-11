// Package reactions implementa el control anti-spam y el bucketing de reacciones.
package reactions

import (
	"sync"
	"time"
)

const (
	// DefaultIdleTTL es cuánto se conservan los conteos de una sala sin
	// reacciones: el periodo de gracia de la sala (REQ-07, 12 h).
	DefaultIdleTTL = 12 * time.Hour
	// pruneEvery limita la frecuencia del barrido de salas inactivas.
	pruneEvery = time.Minute
)

// Buckets cuenta reacciones por sala, ventana de 5s y emoji (base del
// heatmap HU-GAM-02). Todo en memoria: suficiente con una réplica. Las salas
// sin reacciones durante IdleTTL se podan para acotar la memoria.
type Buckets struct {
	// Now es el reloj (inyectable en pruebas); nil = time.Now.
	Now func() time.Time
	// IdleTTL es la inactividad tras la que se poda una sala (cero = DefaultIdleTTL).
	IdleTTL time.Duration

	mu        sync.Mutex
	counts    map[string]map[int64]map[string]int
	touched   map[string]time.Time
	lastPrune time.Time
}

// NewBuckets crea un contador vacío.
func NewBuckets() *Buckets {
	return &Buckets{
		counts:  make(map[string]map[int64]map[string]int),
		touched: make(map[string]time.Time),
	}
}

func (b *Buckets) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

func (b *Buckets) idleTTL() time.Duration {
	if b.IdleTTL > 0 {
		return b.IdleTTL
	}
	return DefaultIdleTTL
}

// Add suma una reacción al bucket.
func (b *Buckets) Add(room string, bucket int64, emoji string) {
	now := b.now()
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	windows := b.counts[room]
	if windows == nil {
		windows = make(map[int64]map[string]int)
		b.counts[room] = windows
	}
	emojis := windows[bucket]
	if emojis == nil {
		emojis = make(map[string]int)
		windows[bucket] = emojis
	}
	emojis[emoji]++
	b.touched[room] = now
}

// pruneLocked borra las salas inactivas, como mucho una vez por pruneEvery.
func (b *Buckets) pruneLocked(now time.Time) {
	if !b.lastPrune.IsZero() && now.Sub(b.lastPrune) < pruneEvery {
		return
	}
	b.lastPrune = now
	cutoff := now.Add(-b.idleTTL())
	for room, at := range b.touched {
		if at.Before(cutoff) {
			delete(b.touched, room)
			delete(b.counts, room)
		}
	}
}

// Count devuelve el acumulado de un emoji en una ventana (0 si no hay).
func (b *Buckets) Count(room string, bucket int64, emoji string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.counts[room][bucket][emoji]
}

// Rooms devuelve cuántas salas tienen conteos en memoria.
func (b *Buckets) Rooms() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.counts)
}
