package recap

import (
	"context"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func TestPositionProjectsFromLocalClock(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	now := time.UnixMilli(5_000_000).UTC()

	if _, ok, err := s.Position(ctx, "r1", now); err != nil || ok {
		t.Fatalf("sin ancla = %v %v, want ok=false", ok, err)
	}

	// updated_at_ms es el reloj de sync-core (aquí, 1 h atrasado): nunca se
	// compara con el de social-core. Se proyecta desde seen_at_ms.
	play := socialevent.SyncEvent{EventID: "p", Type: "PLAY", PositionMS: 10_000, Status: "playing", Rate: 1, UpdatedAtMS: 1_400_000, Version: 1}
	if _, err := s.RecordSyncAt(ctx, "r1", play, now); err != nil {
		t.Fatal(err)
	}
	if v := mr.HGet(LastPosKey("r1"), "seen_at_ms"); v != "5000000" {
		t.Fatalf("seen_at_ms = %q", v)
	}
	p, ok, err := s.Position(ctx, "r1", now.Add(5*time.Second))
	if err != nil || !ok || !p.Playing || p.PositionMS != 15_000 || p.Rate != 1 {
		t.Fatalf("Position reproduciendo = %+v %v %v, want 15 000 ms", p, ok, err)
	}
	// Un reloj que va hacia atrás no retrocede la posición.
	if p, _, _ := s.Position(ctx, "r1", now.Add(-time.Second)); p.PositionMS != 10_000 {
		t.Fatalf("reloj atrás = %+v, want 10 000", p)
	}

	rate := socialevent.SyncEvent{EventID: "r", Type: "RATE", PositionMS: 15_000, Status: "playing", Rate: 2, UpdatedAtMS: 1_405_000, Version: 2}
	_, _ = s.RecordSyncAt(ctx, "r1", rate, now.Add(5*time.Second))
	if p, _, _ := s.Position(ctx, "r1", now.Add(8*time.Second)); p.PositionMS != 21_000 || p.Rate != 2 {
		t.Fatalf("Position a 2x = %+v, want 21 000", p)
	}

	pause := socialevent.SyncEvent{EventID: "x", Type: "PAUSE", PositionMS: 22_000, Status: "paused", Rate: 2, UpdatedAtMS: 1_406_000, Version: 3}
	_, _ = s.RecordSyncAt(ctx, "r1", pause, now.Add(9*time.Second))
	if p, ok, _ := s.Position(ctx, "r1", now.Add(time.Minute)); !ok || p.Playing || p.PositionMS != 22_000 {
		t.Fatalf("Position en pausa = %+v, want fija en 22 000", p)
	}
}

// Un ancla escrita antes de seen_at_ms (despliegue previo) se proyecta
// desde updated_at_ms.
func TestPositionLegacyAnchor(t *testing.T) {
	s, mr := testStore(t)
	mr.HSet(LastPosKey("r1"), "pos", "1000", "status", "playing", "rate", "1", "updated_at_ms", "5000000", "version", "1")
	p, ok, err := s.Position(context.Background(), "r1", time.UnixMilli(5_002_000))
	if err != nil || !ok || p.PositionMS != 3000 {
		t.Fatalf("ancla legada = %+v %v %v, want 3000", p, ok, err)
	}
}

func TestPositionRedisDown(t *testing.T) {
	s, mr := testStore(t)
	mr.Close()
	if _, _, err := s.Position(context.Background(), "r1", time.Now()); err == nil {
		t.Fatal("Position con Redis caído debe fallar")
	}
}
