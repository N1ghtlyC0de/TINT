package store

import (
	"context"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// rtCounter cuenta idas y vueltas a Redis (un comando suelto o un pipeline
// completo = 1). Es la métrica estable de estos benchmarks: los ns/op
// dependen de la red y de la carga de la máquina.
type rtCounter struct{ n atomic.Int64 }

func (c *rtCounter) DialHook(next redis.DialHook) redis.DialHook { return next }

func (c *rtCounter) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		c.n.Add(1)
		return next(ctx, cmd)
	}
}

func (c *rtCounter) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		c.n.Add(1)
		return next(ctx, cmds)
	}
}

// countRT empieza a contar idas y vueltas y reinicia el cronómetro; la
// función devuelta publica la métrica rt/op al terminar.
func countRT(b *testing.B, rdbs ...*redis.Client) func() {
	b.Helper()
	c := &rtCounter{}
	for _, rdb := range rdbs {
		rdb.AddHook(c)
	}
	b.ReportAllocs()
	b.ResetTimer()
	return func() { b.ReportMetric(float64(c.n.Load())/float64(b.N), "rt/op") }
}

// benchClient conecta al Redis real de BENCH_REDIS_URL (p. ej.
// redis://localhost:6379/15) o, si no está definida, a un miniredis: con
// miniredis los ns/op no significan nada, pero allocs/op y rt/op sí.
func benchClient(b *testing.B, addr string) *redis.Client {
	b.Helper()
	opt := &redis.Options{Addr: addr}
	if url := os.Getenv("BENCH_REDIS_URL"); url != "" {
		var err error
		if opt, err = redis.ParseURL(url); err != nil {
			b.Fatal(err)
		}
	} else if addr == "" {
		opt.Addr = miniredis.RunT(b).Addr()
	}
	rdb := redis.NewClient(opt)
	b.Cleanup(func() { _ = rdb.Close() })
	return rdb
}

func benchStore(b *testing.B) (*Store, *redis.Client, string) {
	b.Helper()
	rdb := benchClient(b, "")
	s := New(rdb, time.Hour)
	roomID := "bench-" + uuid.NewString()
	if _, err := s.Init(context.Background(), roomID, "h", time.Now().UnixMilli()); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		_ = rdb.Del(context.Background(), syncevent.StateKey(roomID), syncevent.HostsKey(roomID), syncevent.MembersKey(roomID),
			syncevent.HostStatusKey(roomID), syncevent.HostlessSinceKey(roomID)).Err()
	})
	return s, rdb, roomID
}

// BenchmarkPing calibra la ida y vuelta mínima contra el Redis de prueba.
func BenchmarkPing(b *testing.B) {
	_, rdb, _ := benchStore(b)
	ctx := context.Background()
	defer countRT(b, rdb)()
	for i := 0; i < b.N; i++ {
		if err := rdb.Ping(ctx).Err(); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkSweepRoom: lo que el barrido hace por sala y segundo (latido en
// lote de 1 host + 49 participantes, foto de presencia y HOST_STATUS).
// Antes eran Beat + Presence + SetHostStatus (3 idas y vueltas).
func BenchmarkSweepRoom(b *testing.B) {
	s, rdb, roomID := benchStore(b)
	ctx := context.Background()
	members := make([]string, 49)
	for i := range members {
		members[i] = "guest:" + strconv.Itoa(i)
	}
	hosts := []string{"conn-host"}
	defer countRT(b, rdb)()
	for i := 0; i < b.N; i++ {
		nowMs := time.Now().UnixMilli()
		if _, _, err := s.Sweep(ctx, roomID, hosts, members, nowMs); err != nil {
			b.Fatal(err)
		}
	}
}

func benchEncode(st master.State) ([]byte, error) {
	return []byte(strconv.FormatInt(st.Version, 10)), nil
}

// Un solo host: el caso normal de una sala.
func BenchmarkApplySerial(b *testing.B) {
	s, rdb, roomID := benchStore(b)
	ctx := context.Background()
	defer countRT(b, rdb)()
	for i := 0; i < b.N; i++ {
		cmd := master.Command{Type: syncevent.Seek, PositionMs: int64(i)}
		if _, _, err := s.Apply(ctx, roomID, uuid.NewString(), cmd, time.Now().UnixMilli(), 0, benchEncode); err != nil {
			b.Fatal(err)
		}
	}
}

// Varios cohosts compitiendo por la misma sala: mide el costo de los conflictos.
func BenchmarkApplyContended(b *testing.B) {
	s, rdb, roomID := benchStore(b)
	ctx := context.Background()
	var n atomic.Int64
	b.SetParallelism(4)
	defer countRT(b, rdb)()
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
	a, rdbA, roomID := benchStore(b)
	rdbB := benchClient(b, rdbA.Options().Addr)
	replicas := []*Store{a, New(rdbB, time.Hour)}
	ctx := context.Background()
	var n atomic.Int64
	b.SetParallelism(4)
	defer countRT(b, rdbA, rdbB)()
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
