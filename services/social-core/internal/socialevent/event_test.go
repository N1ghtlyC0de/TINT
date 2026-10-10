package socialevent

import (
	"strings"
	"testing"
	"time"
)

func baseSend() ChatSend {
	return ChatSend{
		EventID:    "e1",
		Type:       TypeChatSend,
		RoomID:     "r1",
		Text:       "Hola grupo",
		OccurredAt: time.Now().UTC(),
	}
}

func TestChatSendOK(t *testing.T) {
	if err := baseSend().Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
}

func TestChatSendRejects(t *testing.T) {
	now := time.Now().UTC()
	cases := map[string]ChatSend{
		"sin event_id":    {Type: TypeChatSend, RoomID: "r1", Text: "hola", OccurredAt: now},
		"tipo incorrecto": {EventID: "e", Type: "reaction", RoomID: "r1", Text: "hola", OccurredAt: now},
		"sin sala":        {EventID: "e", Type: TypeChatSend, Text: "hola", OccurredAt: now},
		"vacío":           {EventID: "e", Type: TypeChatSend, RoomID: "r1", Text: "   ", OccurredAt: now},
		"sin occurred":    {EventID: "e", Type: TypeChatSend, RoomID: "r1", Text: "hola"},
		"muy largo":       {EventID: "e", Type: TypeChatSend, RoomID: "r1", Text: strings.Repeat("a", MaxTextRunes+1), OccurredAt: now},
	}
	for name, m := range cases {
		if err := m.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil, want error", name)
		}
	}
}

func TestChatSendAllows280RunesWithEmoji(t *testing.T) {
	m := baseSend()
	m.Text = strings.Repeat("👏", MaxTextRunes)
	if err := m.Validate(); err != nil {
		t.Fatalf("280 emojis deben pasar, got %v", err)
	}
	m.Text += "x"
	if err := m.Validate(); err != ErrTextTooLong {
		t.Fatalf("281 runes debe fallar con ErrTextTooLong, got %v", err)
	}
}

func TestChatMessageReceivedBeforeOccurred(t *testing.T) {
	now := time.Now().UTC()
	m := ChatMessage{
		EventID: "e", Type: TypeChatMessage, RoomID: "r1",
		UserID: "u1", Nick: "Ana", Text: "hola",
		OccurredAt: now, ReceivedAt: now.Add(-time.Second),
	}
	if err := m.Validate(); err != ErrReceivedBefore {
		t.Fatalf("Validate() = %v, want ErrReceivedBefore", err)
	}
}
