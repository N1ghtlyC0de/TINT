// Package reactions implementa el control anti-spam y el bucketing de reacciones.
package reactions

import (
	"sync"
)

// Buckets cuenta reacciones por sala, ventana de 5s y emoji (base del
// heatmap HU-GAM-02). Todo en memoria: suficiente con una réplica.
type Buckets struct {
	mu     sync.Mutex
	counts map[string]map[int64]map[string]int
}

// NewBuckets crea un contador vacío.
func NewBuckets() *Buckets {
	return &Buckets{counts: make(map[string]map[int64]map[string]int)}
}

// Add suma una reacción al bucket.
func (b *Buckets) Add(room string, bucket int64, emoji string) {
	b.mu.Lock()
	defer b.mu.Unlock()
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
}

// Count devuelve el acumulado de un emoji en una ventana (0 si no hay).
func (b *Buckets) Count(room string, bucket int64, emoji string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.counts[room][bucket][emoji]
}
