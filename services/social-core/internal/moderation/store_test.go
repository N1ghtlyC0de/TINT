package moderation

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func testStore(t *testing.T) (*Store, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return NewStore(client, 0), mr
}

func TestValidSlowMode(t *testing.T) {
	for _, s := range []int{0, 5, 10, 30, 60} {
		if !ValidSlowMode(s) {
			t.Errorf("%d debe ser válido", s)
		}
	}
	for _, s := range []int{-5, 1, 15, 61, 120} {
		if ValidSlowMode(s) {
			t.Errorf("%d no debe ser válido", s)
		}
	}
}

func TestSettingsDefaultsAndChanges(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	got, err := s.Settings(ctx, "r1")
	if err != nil || got.SlowModeS != 0 || got.MutedUserIDs == nil || len(got.MutedUserIDs) != 0 {
		t.Fatalf("Settings vacío = %+v %v, want 0 y lista vacía (no nil)", got, err)
	}
	if err := s.SetSlowMode(ctx, "r1", 10); err != nil {
		t.Fatal(err)
	}
	for _, u := range []string{"guest:zoe", "guest:ana"} {
		if err := s.SetMuted(ctx, "r1", u, true); err != nil {
			t.Fatal(err)
		}
	}
	got, err = s.Settings(ctx, "r1")
	if err != nil || got.SlowModeS != 10 || len(got.MutedUserIDs) != 2 || got.MutedUserIDs[0] != "guest:ana" {
		t.Fatalf("Settings = %+v %v, want 10 s y silenciados ordenados", got, err)
	}
	if err := s.SetMuted(ctx, "r1", "guest:zoe", false); err != nil {
		t.Fatal(err)
	}
	if got, _ = s.Settings(ctx, "r1"); len(got.MutedUserIDs) != 1 || got.MutedUserIDs[0] != "guest:ana" {
		t.Fatalf("tras quitar silencio = %+v", got)
	}
	for _, k := range []string{SettingsKey("r1"), MutedKey("r1")} {
		if ttl := mr.TTL(k); ttl != DefaultTTL {
			t.Fatalf("TTL %s = %v, want %v", k, ttl, DefaultTTL)
		}
	}
}

func TestAdmitMutedAndSlowMode(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	// Sin modo lento ni silencio: siempre pasa y no deja marca.
	for i := 0; i < 3; i++ {
		if v, err := s.Admit(ctx, "r1", "guest:beto"); err != nil || v.Muted || v.RetryAfterMS != 0 {
			t.Fatalf("Admit libre = %+v %v", v, err)
		}
	}
	if mr.Exists(LastKey("r1", "guest:beto")) {
		t.Fatal("sin modo lento no debe haber marca")
	}

	_ = s.SetSlowMode(ctx, "r1", 10)
	if v, err := s.Admit(ctx, "r1", "guest:beto"); err != nil || v.RetryAfterMS != 0 {
		t.Fatalf("primer mensaje con modo lento = %+v %v", v, err)
	}
	mr.FastForward(3 * time.Second)
	v, err := s.Admit(ctx, "r1", "guest:beto")
	if err != nil || v.RetryAfterMS != 7000 {
		t.Fatalf("segundo mensaje a los 3 s = %+v %v, want retry 7000", v, err)
	}
	// La marca es por sub: otro usuario no queda frenado.
	if v, _ := s.Admit(ctx, "r1", "guest:caro"); v.RetryAfterMS != 0 {
		t.Fatalf("otro usuario = %+v", v)
	}
	mr.FastForward(7 * time.Second)
	if v, _ := s.Admit(ctx, "r1", "guest:beto"); v.RetryAfterMS != 0 {
		t.Fatalf("tras la ventana = %+v", v)
	}

	_ = s.SetMuted(ctx, "r1", "guest:beto", true)
	mr.FastForward(time.Minute)
	if v, err := s.Admit(ctx, "r1", "guest:beto"); err != nil || !v.Muted {
		t.Fatalf("silenciado = %+v %v, want Muted", v, err)
	}
	// Con el modo lento apagado no hay freno.
	_ = s.SetSlowMode(ctx, "r1", 0)
	_, _ = s.Admit(ctx, "r1", "guest:caro")
	if v, _ := s.Admit(ctx, "r1", "guest:caro"); v.RetryAfterMS != 0 {
		t.Fatalf("modo lento apagado = %+v", v)
	}
}

func TestStoreErrorsWithRedisDown(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	mr.Close()
	if _, err := s.Admit(ctx, "r1", "u"); err == nil {
		t.Fatal("Admit con Redis caído debe fallar (falla cerrado)")
	}
	if _, err := s.Settings(ctx, "r1"); err == nil {
		t.Fatal("Settings con Redis caído debe fallar")
	}
	if err := s.SetSlowMode(ctx, "r1", 5); err == nil {
		t.Fatal("SetSlowMode con Redis caído debe fallar")
	}
	if err := s.SetMuted(ctx, "r1", "u", true); err == nil {
		t.Fatal("SetMuted con Redis caído debe fallar")
	}
}
