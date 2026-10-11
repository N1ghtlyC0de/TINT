package store

import (
	"context"
	"strconv"
	"testing"

	"github.com/alicebob/miniredis/v2"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// snapshot resume en texto las claves de presencia de una sala y sus TTL.
func snapshot(t *testing.T, mr *miniredis.Miniredis, roomID string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, key := range []string{syncevent.HostsKey(roomID), syncevent.MembersKey(roomID)} {
		if !mr.Exists(key) {
			continue
		}
		members, err := mr.ZMembers(key)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range members {
			score, _ := mr.ZScore(key, m)
			out[key[len("room:"+roomID):]+"/"+m] = strconv.FormatFloat(score, 'f', -1, 64)
		}
		out[key[len("room:"+roomID):]+"/ttl"] = mr.TTL(key).String()
	}
	for _, key := range []string{syncevent.HostStatusKey(roomID), syncevent.HostlessSinceKey(roomID)} {
		if v, err := mr.Get(key); err == nil {
			out[key[len("room:"+roomID):]] = v + " ttl " + mr.TTL(key).String()
		}
	}
	out["state-ttl"] = mr.TTL(syncevent.StateKey(roomID)).String()
	return out
}

// Sweep hace en una ida y vuelta lo mismo que Beat + Presence +
// SetHostStatus: mismo resultado y mismas claves en Redis.
func TestSweepMatchesBeatPresenceAndHostStatus(t *testing.T) {
	s, mr, rdb := setup(t)
	ctx := context.Background()
	const old, fused = "sala-a", "sala-b"
	for _, r := range []string{old, fused} {
		if _, err := s.Init(ctx, r, "", t0); err != nil {
			t.Fatal(err)
		}
		if err := s.Touch(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	steps := []struct {
		hosts, members []string
		now            int64
	}{
		{nil, nil, t0}, // sala vacía, sin host nunca
		{[]string{"c1"}, []string{"g:b", "g:a"}, t0},   // llega el host
		{nil, []string{"g:a"}, t0 + 1000},              // el host sigue vivo (latió hace 1 s)
		{nil, []string{"g:a"}, t0 + 6000},              // el host expira: transición
		{nil, []string{"g:a", "g:c"}, t0 + 7000},       // sigue sin host
		{[]string{"c2", "c3"}, nil, t0 + 8000},         // vuelve
		{nil, nil, t0 + 9000},                          // sin latidos locales
		{[]string{"c2"}, []string{"g:a"}, t0 + 20_000}, // nuevo latido tras expirar
	}
	// La primera ejecución carga el script (EVALSHA falla y va EVAL).
	if _, _, err := s.Sweep(ctx, "calentar", nil, nil, t0); err != nil {
		t.Fatal(err)
	}
	rt := &rtCounter{}
	rdb.AddHook(rt)
	for i, st := range steps {
		if err := s.Beat(ctx, old, st.hosts, st.members, st.now); err != nil {
			t.Fatal(err)
		}
		wantP, err := s.Presence(ctx, old, st.now)
		if err != nil {
			t.Fatal(err)
		}
		wantChanged, err := s.SetHostStatus(ctx, old, wantP.Online > 0, st.now)
		if err != nil {
			t.Fatal(err)
		}

		before := rt.n.Load()
		gotP, gotChanged, err := s.Sweep(ctx, fused, st.hosts, st.members, st.now)
		if err != nil {
			t.Fatalf("paso %d: %v", i, err)
		}
		if gotP != wantP || gotChanged != wantChanged {
			t.Errorf("paso %d: Sweep = %+v changed=%v, want %+v changed=%v", i, gotP, gotChanged, wantP, wantChanged)
		}
		if n := rt.n.Load() - before; n != 1 {
			t.Errorf("paso %d: idas y vueltas = %d, want 1", i, n)
		}
		a, b := snapshot(t, mr, old), snapshot(t, mr, fused)
		if len(a) != len(b) {
			t.Errorf("paso %d: claves %v vs %v", i, a, b)
		}
		for k, v := range a {
			if b[k] != v {
				t.Errorf("paso %d: %s = %q, want %q", i, k, b[k], v)
			}
		}
	}
}

// Salas grandes: los latidos van en tandas dentro del script (unpack de Lua
// tiene un límite de argumentos).
func TestSweepLargeRoom(t *testing.T) {
	s, mr, _ := setup(t)
	members := make([]string, 5000)
	for i := range members {
		members[i] = "g:" + strconv.Itoa(i)
	}
	if _, _, err := s.Sweep(context.Background(), room, []string{"c1"}, members, t0); err != nil {
		t.Fatal(err)
	}
	got, _ := mr.ZMembers(syncevent.MembersKey(room))
	if len(got) != len(members) {
		t.Errorf("miembros = %d, want %d", len(got), len(members))
	}
}

func TestSweepRedisDown(t *testing.T) {
	s, mr, _ := setup(t)
	mr.Close()
	if _, _, err := s.Sweep(context.Background(), room, nil, []string{"g"}, t0); err == nil {
		t.Error("Sweep con Redis caído debe fallar")
	}
}
