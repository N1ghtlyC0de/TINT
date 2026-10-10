package chat

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func testRedis(t *testing.T) (*RedisStore, func()) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	store := NewRedisStoreWithClient(client, 3, time.Hour)
	return store, func() { _ = client.Close(); mr.Close() }
}

func msg(id, text string) socialevent.ChatMessage {
	now := time.Now().UTC()
	return socialevent.ChatMessage{
		EventID: id, Type: socialevent.TypeChatMessage, RoomID: "r1",
		UserID: "u1", Nick: "Ana", Text: text,
		OccurredAt: now, ReceivedAt: now,
	}
}

func TestRedisHistoryRoundTripAndTrim(t *testing.T) {
	s, done := testRedis(t)
	defer done()
	ctx := context.Background()
	for _, id := range []string{"1", "2", "3", "4"} {
		if err := s.Push(ctx, "r1", msg(id, "hola "+id)); err != nil {
			t.Fatalf("Push: %v", err)
		}
	}
	got, err := s.Recent(ctx, "r1", 10)
	if err != nil {
		t.Fatalf("Recent: %v", err)
	}
	if len(got) != 3 || got[0].EventID != "2" || got[2].EventID != "4" {
		t.Fatalf("historial = %v, want [2 3 4] cronológico", got)
	}
	empty, err := s.Recent(ctx, "otra", 10)
	if err != nil || len(empty) != 0 {
		t.Fatalf("sala vacía = %v, %v", empty, err)
	}
}

func TestRedisPubSubAndTrack(t *testing.T) {
	s, done := testRedis(t)
	defer done()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sub, stop := s.Subscribe(ctx, "r1")
	defer stop()
	m := msg("9", "hola pubsub")
	if err := s.Publish(ctx, "r1", m); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	select {
	case got := <-sub:
		if got.EventID != "9" || got.Text != "hola pubsub" {
			t.Fatalf("sub = %+v", got)
		}
	case <-ctx.Done():
		t.Fatal("timeout esperando Pub/Sub")
	}
	if err := s.TrackChat(ctx, m, 11); err != nil {
		t.Fatalf("TrackChat: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestNewRedisStoreDefaultsAndBadURL(t *testing.T) {
	if _, err := NewRedisStore("://mal", 0, 0); err == nil {
		t.Fatal("URL mala debe fallar")
	}
	s, err := NewRedisStore("redis://localhost:6379", 0, 0)
	if err != nil {
		t.Fatalf("Parse URL válida: %v", err)
	}
	_ = s.Close()
}
