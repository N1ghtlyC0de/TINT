package socialevent

import (
	"testing"
	"time"
)

func TestChatMessageValidateBranches(t *testing.T) {
	now := time.Now().UTC()
	ok := ChatMessage{
		EventID: "e", Type: TypeChatMessage, RoomID: "r1",
		UserID: "u", Nick: "Ana", Text: "hola",
		OccurredAt: now, ReceivedAt: now,
	}
	if err := ok.Validate(); err != nil {
		t.Fatalf("ok = %v", err)
	}
	cases := map[string]ChatMessage{
		"sin event":   {Type: TypeChatMessage, RoomID: "r1", UserID: "u", Text: "hola", OccurredAt: now, ReceivedAt: now},
		"tipo malo":   {EventID: "e", Type: "x", RoomID: "r1", Text: "hola", OccurredAt: now, ReceivedAt: now},
		"sin sala":    {EventID: "e", Type: TypeChatMessage, Text: "hola", OccurredAt: now, ReceivedAt: now},
		"vacío":       {EventID: "e", Type: TypeChatMessage, RoomID: "r1", Text: "  ", OccurredAt: now, ReceivedAt: now},
		"sin times":   {EventID: "e", Type: TypeChatMessage, RoomID: "r1", Text: "hola"},
		"received<oc": {EventID: "e", Type: TypeChatMessage, RoomID: "r1", Text: "hola", OccurredAt: now, ReceivedAt: now.Add(-time.Second)},
	}
	for name, m := range cases {
		if err := m.Validate(); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	tooLong := ok
	tooLong.Text = string(make([]rune, MaxTextRunes+1))
	for i := range tooLong.Text {
		_ = i
	}
	// Construir 281 runes de forma explícita.
	runes := make([]rune, MaxTextRunes+1)
	for i := range runes {
		runes[i] = 'a'
	}
	tooLong.Text = string(runes)
	if err := tooLong.Validate(); err != ErrTextTooLong {
		t.Fatalf("largo = %v, want ErrTextTooLong", err)
	}
}
