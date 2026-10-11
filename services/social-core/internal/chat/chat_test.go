package chat

import (
	"context"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func sampleMsg(id string) socialevent.ChatMessage {
	now := time.Now().UTC()
	return socialevent.ChatMessage{
		EventID: id, Type: socialevent.TypeChatMessage, RoomID: "r1",
		UserID: "u1", Nick: "Ana", Text: "hola " + id,
		OccurredAt: now, ReceivedAt: now,
	}
}

func TestMemoryStoreKeepsLastN(t *testing.T) {
	s := NewMemoryStore(3)
	ctx := context.Background()
	for _, id := range []string{"1", "2", "3", "4"} {
		if err := s.Push(ctx, "r1", sampleMsg(id)); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.Recent(ctx, "r1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].EventID != "2" || got[2].EventID != "4" {
		t.Fatalf("historial = %v, want [2 3 4]", got)
	}
	if _, err := s.Recent(ctx, "otra", 10); err != nil {
		t.Fatal(err)
	}
}

func TestKeys(t *testing.T) {
	if HistoryKey("r1") != "room:r1:chat:history" {
		t.Errorf("HistoryKey = %q", HistoryKey("r1"))
	}
	if ChannelKey("r1") != "room:r1:social" {
		t.Errorf("ChannelKey = %q", ChannelKey("r1"))
	}
	if SyncChannelKey("r1") != "room:r1:sync" || RevokedKey("j") != "token:revoked:j" {
		t.Errorf("claves de revocación = %q, %q", SyncChannelKey("r1"), RevokedKey("j"))
	}
}

func TestHubIsolatesRooms(t *testing.T) {
	h := NewHub()
	a := make(chan []byte, 4)
	b := make(chan []byte, 4)
	other := make(chan []byte, 4)
	h.Join("r1", "a", a)
	h.Join("r1", "b", b)
	h.Join("r2", "c", other)

	if got := h.Broadcast("r1", []byte("hola")); got != 2 {
		t.Fatalf("Broadcast = %d, want 2", got)
	}
	if len(other) != 0 {
		t.Fatal("mensaje de r1 no debe llegar a r2")
	}
	if h.Members("r1") != 2 {
		t.Fatalf("Members = %d, want 2", h.Members("r1"))
	}
	h.Leave("r1", "a")
	if h.Members("r1") != 1 {
		t.Fatalf("tras Leave Members = %d, want 1", h.Members("r1"))
	}
}

func TestHubDoesNotBlockOnFullChannel(t *testing.T) {
	h := NewHub()
	blocked := make(chan []byte) // sin buffer ni lector
	ok := make(chan []byte, 1)
	h.Join("r1", "blocked", blocked)
	h.Join("r1", "ok", ok)
	if got := h.Broadcast("r1", []byte("x")); got != 1 {
		t.Fatalf("Broadcast = %d, want 1 (no bloquear)", got)
	}
}

func TestHubLeaveMissingRoomIsNoop(t *testing.T) {
	h := NewHub()
	h.Leave("inexistente", "x")
	if h.Members("inexistente") != 0 {
		t.Fatal("Members de sala inexistente debe ser 0")
	}
}

func TestMemoryStoreDefaultLimit(t *testing.T) {
	s := NewMemoryStore(0)
	ctx := context.Background()
	for i := 0; i < HistoryLimit+5; i++ {
		if err := s.Push(ctx, "r1", sampleMsg("m")); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := s.Recent(ctx, "r1", 0)
	if len(got) != HistoryLimit {
		t.Fatalf("len = %d, want %d", len(got), HistoryLimit)
	}
}
