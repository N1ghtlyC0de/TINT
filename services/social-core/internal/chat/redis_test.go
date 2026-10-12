package chat

import (
	"context"
	"runtime"
	"strings"
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
		if got.EventID != "9" || !strings.Contains(string(got.Payload), "hola pubsub") || got.RevokedJTI != "" {
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

// identity-api revoca con SET token:revoked:{jti} y PUBLISH REVOKED en
// room:{id}:sync (contrato v2 §5). La suscripción de sala lo entrega como
// RevokedJTI e ignora el resto del tráfico de sync-core.
func TestRedisSubscribeDeliversRevoked(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	s := NewRedisStoreWithClient(client, 3, time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sub, stop := s.Subscribe(ctx, "r1")
	defer stop()
	waitSubscribers(t, mr, SyncChannelKey("r1"))

	for _, raw := range []string{
		`{"type":"PLAY","room_id":"r1","event_id":"p1"}`,
		`no-json`,
		`{"type":"REVOKED","room_id":"r1"}`,
		`{"event_id":"x","type":"REVOKED","room_id":"r1","jti":"J1","position_ms":0,"version":0}`,
	} {
		if err := client.Publish(ctx, SyncChannelKey("r1"), raw).Err(); err != nil {
			t.Fatal(err)
		}
	}
	// Basura en el canal social tampoco se reenvía.
	_ = client.Publish(ctx, ChannelKey("r1"), "no-json").Err()
	_ = client.Publish(ctx, ChannelKey("r1"), `{"type":"otro","event_id":"z"}`).Err()
	select {
	case got := <-sub:
		if got.RevokedJTI != "J1" || got.Payload != nil {
			t.Fatalf("sub = %+v, want RevokedJTI J1", got)
		}
	case <-ctx.Done():
		t.Fatal("timeout esperando REVOKED")
	}
}

func TestRedisPublishReactionRelayed(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	s := NewRedisStoreWithClient(client, 3, time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sub, stop := s.Subscribe(ctx, "r1")
	defer stop()
	waitSubscribers(t, mr, ChannelKey("r1"))
	now := time.Now().UTC()
	r := socialevent.Reaction{
		EventID: "re1", Type: socialevent.TypeReaction, RoomID: "r1", UserID: "u1",
		Nick: "Ana", Emoji: "👏", PositionMS: 5000, OccurredAt: now, ReceivedAt: now,
	}
	if err := s.PublishReaction(ctx, "r1", r); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-sub:
		if got.EventID != "re1" || !strings.Contains(string(got.Payload), `"type":"reaction"`) {
			t.Fatalf("sub = %+v", got)
		}
	case <-ctx.Done():
		t.Fatal("timeout esperando la reacción")
	}
}

// El puntero láser viaja por el mismo canal, re-serializado por tipo.
func TestRedisPublishRawLaserRelayed(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	s := NewRedisStoreWithClient(client, 3, time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sub, stop := s.Subscribe(ctx, "r1")
	defer stop()
	waitSubscribers(t, mr, ChannelKey("r1"))
	raw := `{"event_id":"l1","type":"laser","room_id":"r1","user_id":"h","nick":"Ana","x":0.5,"y":0.25,"end":false,"extra":"x"}`
	if err := s.PublishRaw(ctx, "r1", []byte(raw)); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-sub:
		if got.EventID != "l1" || !strings.Contains(string(got.Payload), `"x":0.5`) || strings.Contains(string(got.Payload), "extra") {
			t.Fatalf("sub = %+v, want laser re-serializado", got)
		}
	case <-ctx.Done():
		t.Fatal("timeout esperando el láser")
	}
}

func waitSubscribers(t *testing.T, mr *miniredis.Miniredis, channel string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for mr.PubSubNumSub(channel)[channel] == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("sin suscriptores en %s", channel)
		}
		runtime.Gosched()
	}
}

func TestRedisIsRevoked(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	s := NewRedisStoreWithClient(client, 3, time.Hour)
	ctx := context.Background()
	if err := mr.Set(RevokedKey("J1"), "1"); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.IsRevoked(ctx, "J1"); err != nil || !ok {
		t.Fatalf("J1 = %v, %v, want revocado", ok, err)
	}
	if ok, err := s.IsRevoked(ctx, "J2"); err != nil || ok {
		t.Fatalf("J2 = %v, %v, want vigente", ok, err)
	}
	mr.Close()
	if _, err := s.IsRevoked(ctx, "J2"); err == nil {
		t.Fatal("con Redis caído debe devolver error (el handshake falla cerrado)")
	}
}
