package store

import (
	"context"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// Los benchmarks usan un Redis real (BENCH_REDIS_URL, p. ej.
// redis://localhost:6379/15): con miniredis los tiempos no significan nada.
func benchStore(b *testing.B) (*Store, string) {
	b.Helper()
	url := os.Getenv("BENCH_REDIS_URL")
	if url == "" {
		b.Skip("define BENCH_REDIS_URL para medir contra Redis real")
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		b.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	b.Cleanup(func() { _ = rdb.Close() })
	s := New(rdb, time.Hour)
	roomID := "bench-" + uuid.NewString()
	if _, err := s.Init(context.Background(), roomID, "h", time.Now().UnixMilli()); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		_ = rdb.Del(context.Background(), syncevent.StateKey(roomID)).Err()
	})
	return s, roomID
}

func benchEncode(st master.State) ([]byte, error) {
	return []byte(strconv.FormatInt(st.Version, 10)), nil
}

// Un solo host: el caso normal de una sala.
func BenchmarkApplySerial(b *testing.B) {
	s, roomID := benchStore(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		cmd := master.Command{Type: syncevent.Seek, PositionMs: int64(i)}
		if _, _, err := s.Apply(ctx, roomID, uuid.NewString(), cmd, time.Now().UnixMilli(), 0, benchEncode); err != nil {
			b.Fatal(err)
		}
	}
}

// Varios cohosts compitiendo por la misma sala: mide el costo de los conflictos.
func BenchmarkApplyContended(b *testing.B) {
	s, roomID := benchStore(b)
	ctx := context.Background()
	var n atomic.Int64
	b.SetParallelism(4)
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			cmd := master.Command{Type: syncevent.Seek, PositionMs: n.Add(1)}
			if _, _, err := s.Apply(ctx, roomID, uuid.NewString(), cmd, time.Now().UnixMilli(), 0, benchEncode); err != nil {
				b.Error(err)
				return
			}
		}
	})
}

// Dos réplicas compitiendo: el candado local no las serializa, solo el CAS.
func BenchmarkApplyTwoReplicas(b *testing.B) {
	a, roomID := benchStore(b)
	opt, _ := redis.ParseURL(os.Getenv("BENCH_REDIS_URL"))
	rdb := redis.NewClient(opt)
	b.Cleanup(func() { _ = rdb.Close() })
	replicas := []*Store{a, New(rdb, time.Hour)}
	ctx := context.Background()
	var n atomic.Int64
	b.SetParallelism(4)
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		s := replicas[n.Add(1)%2]
		for pb.Next() {
			cmd := master.Command{Type: syncevent.Seek, PositionMs: n.Add(1)}
			if _, _, err := s.Apply(ctx, roomID, uuid.NewString(), cmd, time.Now().UnixMilli(), 0, benchEncode); err != nil {
				b.Error(err)
				return
			}
		}
	})
}
