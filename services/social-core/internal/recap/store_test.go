package recap

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func testStore(t *testing.T) (*Store, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return NewStore(client, 0), mr
}

func TestEmptyRecapHasNulls(t *testing.T) {
	s, _ := testStore(t)
	got, err := s.Build(context.Background(), "r1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != socialevent.TypeRecap || got.RoomID != "r1" {
		t.Fatalf("recap = %+v", got)
	}
	if got.TopEmojiUser != nil || got.MostPaused != nil || got.PeakReactions != nil {
		t.Fatalf("sala sin datos = %+v, want nulls", got)
	}
	if got.Totals != (socialevent.RecapTotals{}) {
		t.Fatalf("totales = %+v, want ceros", got.Totals)
	}
}

func TestReactionsFeedTopUserAndPeak(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	add := func(user, nick, emoji string, pos int64) {
		t.Helper()
		if err := s.RecordReaction(ctx, "r1", user, nick, emoji, pos); err != nil {
			t.Fatal(err)
		}
	}
	add("u1", "Ana", "👏", 1_000)
	add("u2", "Beto", "😂", 12_000)
	add("u2", "Beto", "😂", 13_000)
	add("u2", "Beto Jr", "❤️", 14_999) // el nick más reciente gana
	add("u1", "Ana", "😂", 30_000)

	got, err := s.Build(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if got.TopEmojiUser == nil || *got.TopEmojiUser != (socialevent.TopEmojiUser{UserID: "u2", Nick: "Beto Jr", Count: 3}) {
		t.Fatalf("top = %+v", got.TopEmojiUser)
	}
	// Bucket 2 (10 000–14 999 ms): 3 reacciones, 2 risas.
	if got.PeakReactions == nil || *got.PeakReactions != (socialevent.PeakReactions{PositionMS: 10_000, Count: 3, Laughs: 2}) {
		t.Fatalf("pico = %+v", got.PeakReactions)
	}
	if got.Totals.Reactions != 5 {
		t.Fatalf("total reacciones = %d, want 5", got.Totals.Reactions)
	}
	for _, k := range []string{EmojisByUserKey("r1"), NicksKey("r1"), ReactionsKey("r1"), LaughsKey("r1"), TotalsKey("r1")} {
		if ttl := mr.TTL(k); ttl != DefaultTTL {
			t.Fatalf("TTL %s = %v, want %v", k, ttl, DefaultTTL)
		}
	}
}

func TestTiesPickEarliestAndSmallest(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	_ = s.RecordReaction(ctx, "r1", "zeta", "Z", "👏", 20_000)
	_ = s.RecordReaction(ctx, "r1", "alfa", "A", "👏", 5_000)
	got, _ := s.Build(ctx, "r1")
	if got.TopEmojiUser.UserID != "alfa" {
		t.Fatalf("empate de usuarios = %+v, want alfa (orden estable)", got.TopEmojiUser)
	}
	if got.PeakReactions.PositionMS != 5_000 || got.PeakReactions.Laughs != 0 {
		t.Fatalf("empate de buckets = %+v, want el más temprano", got.PeakReactions)
	}
}

func syncEv(id, typ string, pos int64, status string, updated, version int64) socialevent.SyncEvent {
	return socialevent.SyncEvent{EventID: id, Type: typ, PositionMS: pos, Status: status, Rate: 1, UpdatedAtMS: updated, Version: version}
}

func TestSyncPausesAndRewinds(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	record := func(ev socialevent.SyncEvent, want Kind) {
		t.Helper()
		got, err := s.RecordSync(ctx, "r1", ev)
		if err != nil || got != want {
			t.Fatalf("RecordSync(%s %s) = %v %v, want %v", ev.EventID, ev.Type, got, err, want)
		}
	}
	// PLAY en 10 s; a los 60 s de reloj, SEEK a 30 s: el vídeo iba por 70 s
	// (proyección del ancla), así que es un rebobinado aunque 30 > 10.
	record(syncEv("e1", "PLAY", 10_000, "playing", 1_000_000, 1), KindNone)
	record(syncEv("e2", "SEEK", 30_000, "playing", 1_060_000, 2), KindRewind)
	// SEEK hacia adelante: no cuenta.
	record(syncEv("e3", "SEEK", 90_000, "playing", 1_061_000, 3), KindNone)
	// PAUSE cuenta siempre, en su bucket.
	record(syncEv("e4", "PAUSE", 92_500, "paused", 1_063_500, 4), KindPause)
	// En pausa no se proyecta: SEEK a 92 s (0,5 s atrás, dentro de la
	// tolerancia) no cuenta; a 31 s sí.
	record(syncEv("e5", "SEEK", 92_000, "paused", 1_070_000, 5), KindNone)
	record(syncEv("e6", "SEEK", 31_000, "paused", 1_071_000, 6), KindRewind)
	// Duplicado entre réplicas (mismo event_id): no se cuenta de nuevo.
	record(syncEv("e6", "SEEK", 31_000, "paused", 1_071_000, 6), KindDuplicate)
	// Llega tarde un evento viejo (version menor): el PAUSE cuenta pero no
	// mueve el ancla, y un SEEK viejo no se clasifica.
	record(syncEv("e0", "SEEK", 0, "paused", 999_000, 1), KindNone)
	record(syncEv("e00", "PAUSE", 5_000, "paused", 999_500, 1), KindPause)
	if pos := mr.HGet(LastPosKey("r1"), "pos"); pos != "31000" {
		t.Fatalf("last_pos = %q, want 31000 (los viejos no lo mueven)", pos)
	}
	if ttl := mr.TTL(SeenKey("r1", "e1")); ttl != SeenTTL {
		t.Fatalf("TTL seen = %v, want %v", ttl, SeenTTL)
	}

	got, err := s.Build(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	// Buckets: 30 s (rewind e2) y 31 s → bucket 6 (30 000 ms) con 2.
	if got.MostPaused == nil || *got.MostPaused != (socialevent.PositionCount{PositionMS: 30_000, Count: 2}) {
		t.Fatalf("más pausado = %+v", got.MostPaused)
	}
	if got.Totals.Pauses != 2 || got.Totals.Rewinds != 2 {
		t.Fatalf("totales = %+v, want 2 pausas y 2 rebobinados", got.Totals)
	}
}

func TestSyncSeekWithoutAnchor(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	// Sin posición previa conocida no se puede saber si es hacia atrás.
	if k, _ := s.RecordSync(ctx, "r1", syncEv("a", "SEEK", 0, "paused", 0, 1)); k != KindNone {
		t.Fatalf("primer SEEK = %v, want KindNone", k)
	}
	// Sin updated_at_ms (productor viejo) se compara la posición cruda.
	if k, _ := s.RecordSync(ctx, "r1", socialevent.SyncEvent{EventID: "b", Type: "PLAY", PositionMS: 50_000}); k != KindNone {
		t.Fatalf("PLAY = %v", k)
	}
	if k, _ := s.RecordSync(ctx, "r1", socialevent.SyncEvent{EventID: "c", Type: "SEEK", PositionMS: 10_000}); k != KindRewind {
		t.Fatalf("SEEK atrás sin ancla temporal = %v, want KindRewind", k)
	}
}

func TestRecordPollAndRedisDown(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	if err := s.RecordPoll(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	_ = s.RecordPoll(ctx, "r1")
	got, _ := s.Build(ctx, "r1")
	if got.Totals.Polls != 2 {
		t.Fatalf("encuestas = %d, want 2", got.Totals.Polls)
	}
	mr.Close()
	if err := s.RecordPoll(ctx, "r1"); err == nil {
		t.Fatal("RecordPoll con Redis caído debe fallar")
	}
	if err := s.RecordReaction(ctx, "r1", "u", "n", "👏", 0); err == nil {
		t.Fatal("RecordReaction con Redis caído debe fallar")
	}
	if _, err := s.RecordSync(ctx, "r1", syncEv("x", "PAUSE", 0, "paused", 1, 1)); err == nil {
		t.Fatal("RecordSync con Redis caído debe fallar")
	}
	if _, err := s.Build(ctx, "r1"); err == nil {
		t.Fatal("Build con Redis caído debe fallar")
	}
}
