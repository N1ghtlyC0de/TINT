package polls

import (
	"context"
	"errors"
	"testing"

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

const t0 = int64(1_000_000)

func samplePoll(id string) Poll {
	return Poll{ID: id, Question: "¿Pizza?", Options: []string{"Sí", "No", "Tal vez"}, ClosesAtMS: t0 + 30_000}
}

func TestCreateOnlyOneActive(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	if err := s.Create(ctx, "r1", samplePoll("p1"), t0); err != nil {
		t.Fatalf("Create = %v", err)
	}
	if err := s.Create(ctx, "r1", samplePoll("p2"), t0+1000); !errors.Is(err, ErrActive) {
		t.Fatalf("segunda encuesta activa = %v, want ErrActive", err)
	}
	// Otra sala es independiente.
	if err := s.Create(ctx, "r2", samplePoll("p9"), t0); err != nil {
		t.Fatalf("otra sala = %v", err)
	}
	// Vencida por tiempo (aunque nadie la haya cerrado) admite una nueva.
	if err := s.Create(ctx, "r1", samplePoll("p3"), t0+30_000); err != nil {
		t.Fatalf("tras vencer = %v", err)
	}
	p, ok, err := s.Current(ctx, "r1")
	if err != nil || !ok || p.ID != "p3" || p.Closed || len(p.Options) != 3 || p.Question != "¿Pizza?" || p.ClosesAtMS != t0+30_000 {
		t.Fatalf("Current = %+v %v %v", p, ok, err)
	}
	if ttl := mr.TTL(PollKey("r1")); ttl != DefaultTTL {
		t.Fatalf("TTL poll = %v, want %v", ttl, DefaultTTL)
	}
}

func TestCreateAfterManualClose(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	_ = s.Create(ctx, "r1", samplePoll("p1"), t0)
	closed, err := s.Close(ctx, "r1", "p1")
	if err != nil || !closed {
		t.Fatalf("Close = %v %v, want true", closed, err)
	}
	again, err := s.Close(ctx, "r1", "p1")
	if err != nil || again {
		t.Fatalf("segundo Close = %v %v, want false (idempotente)", again, err)
	}
	if _, err := s.Close(ctx, "r1", "otra"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Close de otra = %v, want ErrNotFound", err)
	}
	p, _, _ := s.Current(ctx, "r1")
	if !p.Closed {
		t.Fatal("tras Close, Current debe marcar closed")
	}
	if err := s.Create(ctx, "r1", samplePoll("p2"), t0+1); err != nil {
		t.Fatalf("crear tras cierre = %v", err)
	}
}

func TestVoteChangeableAndCounts(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	_ = s.Create(ctx, "r1", samplePoll("p1"), t0)
	must := func(user string, opt int) {
		t.Helper()
		if err := s.Vote(ctx, "r1", "p1", user, opt, t0+10); err != nil {
			t.Fatalf("Vote(%s,%d) = %v", user, opt, err)
		}
	}
	must("ana", 0)
	must("beto", 1)
	must("ana", 2) // cambia su voto: sigue siendo uno
	counts, err := s.Counts(ctx, "r1", "p1", 3)
	if err != nil || counts[0] != 0 || counts[1] != 1 || counts[2] != 1 {
		t.Fatalf("Counts = %v %v, want [0 1 1]", counts, err)
	}
	if v, ok, err := s.VoteOf(ctx, "r1", "p1", "ana"); err != nil || !ok || v != 2 {
		t.Fatalf("VoteOf(ana) = %d %v %v, want 2", v, ok, err)
	}
	if _, ok, err := s.VoteOf(ctx, "r1", "p1", "nadie"); err != nil || ok {
		t.Fatalf("VoteOf(nadie) = %v %v, want sin voto", ok, err)
	}
	if ttl := mr.TTL(VotesKey("r1", "p1")); ttl != DefaultTTL {
		t.Fatalf("TTL votos = %v", ttl)
	}
	if err := s.Vote(ctx, "r1", "p1", "ana", 3, t0+10); !errors.Is(err, ErrOption) {
		t.Fatalf("opción fuera de rango = %v, want ErrOption", err)
	}
	if err := s.Vote(ctx, "r1", "otra", "ana", 0, t0+10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("otra encuesta = %v, want ErrNotFound", err)
	}
	if err := s.Vote(ctx, "r1", "p1", "ana", 0, t0+30_000); !errors.Is(err, ErrClosed) {
		t.Fatalf("voto vencido = %v, want ErrClosed", err)
	}
	_, _ = s.Close(ctx, "r1", "p1")
	if err := s.Vote(ctx, "r1", "p1", "ana", 0, t0+20); !errors.Is(err, ErrClosed) {
		t.Fatalf("voto tras cierre = %v, want ErrClosed", err)
	}
}

func TestCountsIgnoresGarbage(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	mr.HSet(VotesKey("r1", "p1"), "a", "1", "b", "x", "c", "9")
	counts, err := s.Counts(ctx, "r1", "p1", 2)
	if err != nil || counts[0] != 0 || counts[1] != 1 {
		t.Fatalf("Counts = %v %v, want [0 1]", counts, err)
	}
	if _, ok, err := s.Current(ctx, "vacía"); err != nil || ok {
		t.Fatalf("Current sin encuesta = %v %v", ok, err)
	}
	mr.HSet(PollKey("rota"), "id", "p", "options", "no-json", "closes_at_ms", "1")
	if _, _, err := s.Current(ctx, "rota"); err == nil {
		t.Fatal("options corruptas deben dar error")
	}
}

func TestFlushGate(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	if ok, err := s.TryFlush(ctx, "r1"); err != nil || !ok {
		t.Fatalf("primer TryFlush = %v %v, want true", ok, err)
	}
	if ok, _ := s.TryFlush(ctx, "r1"); ok {
		t.Fatal("con flush pendiente no se agenda otro")
	}
	if err := s.ReleaseFlush(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.TryFlush(ctx, "r1"); !ok {
		t.Fatal("tras liberar se puede agendar de nuevo")
	}
}

func TestStoreErrorsWithRedisDown(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	mr.Close()
	if err := s.Create(ctx, "r1", samplePoll("p1"), t0); err == nil {
		t.Fatal("Create con Redis caído debe fallar")
	}
	if err := s.Vote(ctx, "r1", "p1", "a", 0, t0); err == nil {
		t.Fatal("Vote con Redis caído debe fallar")
	}
	if _, err := s.Close(ctx, "r1", "p1"); err == nil {
		t.Fatal("Close con Redis caído debe fallar")
	}
	if _, _, err := s.Current(ctx, "r1"); err == nil {
		t.Fatal("Current con Redis caído debe fallar")
	}
	if _, err := s.Counts(ctx, "r1", "p1", 2); err == nil {
		t.Fatal("Counts con Redis caído debe fallar")
	}
	if _, _, err := s.VoteOf(ctx, "r1", "p1", "a"); err == nil {
		t.Fatal("VoteOf con Redis caído debe fallar")
	}
	if _, err := s.TryFlush(ctx, "r1"); err == nil {
		t.Fatal("TryFlush con Redis caído debe fallar")
	}
}
