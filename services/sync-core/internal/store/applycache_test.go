package store

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

func seek(pos int64) master.Command { return master.Command{Type: syncevent.Seek, PositionMs: pos} }

// Tras un comando propio, el siguiente de la misma sala parte del estado
// que esta réplica acaba de escribir: una sola ida y vuelta (el CAS).
func TestApplyAfterOwnWriteIsOneRoundTrip(t *testing.T) {
	s, _, rdb := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "h", t0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply(ctx, room, "e1", seek(1000), t0, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	rt := &rtCounter{}
	rdb.AddHook(rt)
	st, dup, err := s.Apply(ctx, room, "e2", master.Command{Type: syncevent.Play, PositionMs: 2000}, t0+10, 0, encodeVersion)
	if err != nil || dup || st.Version != 2 || st.Status != master.Playing || st.PositionMs != 2000 {
		t.Fatalf("Apply = %+v dup=%v err=%v", st, dup, err)
	}
	if n := rt.n.Load(); n != 1 {
		t.Errorf("idas y vueltas = %d, want 1", n)
	}
	if loaded, _ := s.Load(ctx, room); loaded != st {
		t.Errorf("Load = %+v, want %+v", loaded, st)
	}
}

// Si otra réplica escribió después, el CAS falla y se relee: el comando se
// aplica sobre el estado real (aquí, el vídeo que cargó la otra réplica).
func TestApplyCacheYieldsToOtherReplica(t *testing.T) {
	mr := miniredis.RunT(t)
	replica := func() *Store {
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		t.Cleanup(func() { _ = rdb.Close() })
		return New(rdb, ttl)
	}
	a, b := replica(), replica()
	ctx := context.Background()
	if _, err := a.Init(ctx, room, "h", t0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.Apply(ctx, room, "e1", seek(1000), t0, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.Apply(ctx, room, "e2", master.Command{Type: syncevent.Load, MediaID: "m-2"}, t0+1, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	st, _, err := a.Apply(ctx, room, "e3", seek(3000), t0+2, 0, encodeVersion)
	if err != nil || st.Version != 3 || st.MediaID != "m-2" || st.PositionMs != 3000 {
		t.Fatalf("Apply = %+v (%v)", st, err)
	}
	if loaded, _ := a.Load(ctx, room); loaded != st {
		t.Errorf("Load = %+v, want %+v", loaded, st)
	}
}

// Init cambia host_id sin subir la version: un comando posterior no debe
// devolverle el host anterior aunque parta del estado en caché.
func TestApplyKeepsHostIDSetByInit(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "h-1", t0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply(ctx, room, "e1", seek(1), t0, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	other := New(redis.NewClient(&redis.Options{Addr: mr.Addr()}), ttl)
	if _, err := other.Init(ctx, room, "h-2", t0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply(ctx, room, "e2", seek(2), t0+1, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	if got := mr.HGet(syncevent.StateKey(room), "host_id"); got != "h-2" {
		t.Errorf("host_id = %q, want h-2", got)
	}
}

// Un duplicado tras un comando propio se detecta igual (lo dice el script).
func TestApplyDuplicateAfterOwnWrite(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "h", t0); err != nil {
		t.Fatal(err)
	}
	first, _, err := s.Apply(ctx, room, "e1", seek(5000), t0, 0, encodeVersion)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply(ctx, room, "e2", seek(6000), t0+1, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	st, dup, err := s.Apply(ctx, room, "e1", seek(7000), t0+2, 0, encodeVersion)
	if err != nil || !dup || st.Version != first.Version+1 || st.PositionMs != 6000 {
		t.Errorf("duplicado = %+v dup=%v err=%v", st, dup, err)
	}
}
