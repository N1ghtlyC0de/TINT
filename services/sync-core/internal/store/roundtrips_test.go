package store

import (
	"context"
	"testing"
)

// Connect y Disconnect hacen varias llamadas al store en serie; cada una
// debe costar una sola ida y vuelta.
func TestConnectDisconnectCallsAreOneRoundTrip(t *testing.T) {
	s, _, rdb := setup(t)
	ctx := context.Background()
	rt := &rtCounter{}
	rdb.AddHook(rt)
	expect := func(name string, fn func() error) {
		t.Helper()
		before := rt.n.Load()
		if err := fn(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if n := rt.n.Load() - before; n != 1 {
			t.Errorf("%s: idas y vueltas = %d, want 1", name, n)
		}
	}
	expect("Init", func() error {
		st, err := s.Init(ctx, room, "h", t0)
		if err == nil && (st.Version != 0 || st.HostID != "h") {
			t.Errorf("Init = %+v", st)
		}
		return err
	})
	expect("HostSeen", func() error {
		n, err := s.HostSeen(ctx, room, "c1", t0)
		if err == nil && n != 1 {
			t.Errorf("HostSeen = %d", n)
		}
		return err
	})
	expect("BeatPresence", func() error {
		p, err := s.BeatPresence(ctx, room, []string{"c2"}, nil, t0)
		if err == nil && p.Online != 2 {
			t.Errorf("BeatPresence = %+v", p)
		}
		return err
	})
	expect("BeatPresence participante", func() error {
		p, err := s.BeatPresence(ctx, room, nil, []string{"g:a"}, t0)
		if err == nil && p.Online != 2 {
			t.Errorf("BeatPresence = %+v", p)
		}
		return err
	})
	expect("HostGone", func() error {
		n, err := s.HostGone(ctx, room, "c1", t0)
		if err == nil && n != 1 {
			t.Errorf("HostGone = %d", n)
		}
		return err
	})
	if m, _ := s.LiveMembers(ctx, room, t0); len(m) != 1 || m[0] != "g:a" {
		t.Errorf("LiveMembers = %v", m)
	}
}

func TestBeatPresenceRedisDown(t *testing.T) {
	s, mr, _ := setup(t)
	mr.Close()
	if _, err := s.BeatPresence(context.Background(), room, nil, []string{"g"}, t0); err == nil {
		t.Error("BeatPresence con Redis caído debe fallar")
	}
}
