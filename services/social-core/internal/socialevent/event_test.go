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

func TestChatMessageAcceptsClockSkew(t *testing.T) {
	now := time.Now().UTC()
	m := ChatMessage{
		EventID: "e", Type: TypeChatMessage, RoomID: "r1",
		UserID: "u1", Nick: "Ana", Text: "hola",
		OccurredAt: now, ReceivedAt: now.Add(-time.Second),
	}
	// Relojes distintos (cliente adelantado) no invalidan el mensaje.
	if err := m.Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
}

func TestClampOccurred(t *testing.T) {
	now := time.Now().UTC()
	if got := ClampOccurred(now.Add(2*time.Second), now); !got.Equal(now) {
		t.Fatalf("futuro = %v, want %v", got, now)
	}
	past := now.Add(-time.Second)
	if got := ClampOccurred(past, now); !got.Equal(past) {
		t.Fatalf("pasado = %v, want %v", got, past)
	}
}

func baseNotice() Notice {
	return Notice{
		EventID: "n1", Type: TypeNotice, RoomID: "r1",
		UserID: "u1", Nick: "Pedro", Kind: NoticeJoined,
		Text: "Pedro entró al chat", OccurredAt: time.Now().UTC(),
	}
}

func TestNoticeOK(t *testing.T) {
	if err := baseNotice().Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
	left := baseNotice()
	left.Kind = NoticeLeft
	left.Text = "Pedro salió del chat"
	if err := left.Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
}

func TestNoticeRejects(t *testing.T) {
	now := time.Now().UTC()
	cases := map[string]Notice{
		"sin event_id":    {Type: TypeNotice, RoomID: "r1", UserID: "u1", Nick: "Pedro", Kind: NoticeJoined, Text: "t", OccurredAt: now},
		"tipo incorrecto": {EventID: "e", Type: "chat_message", RoomID: "r1", UserID: "u1", Nick: "Pedro", Kind: NoticeJoined, Text: "t", OccurredAt: now},
		"sin sala":        {EventID: "e", Type: TypeNotice, UserID: "u1", Nick: "Pedro", Kind: NoticeJoined, Text: "t", OccurredAt: now},
		"sin usuario":     {EventID: "e", Type: TypeNotice, RoomID: "r1", Nick: "Pedro", Kind: NoticeJoined, Text: "t", OccurredAt: now},
		"sin nick":        {EventID: "e", Type: TypeNotice, RoomID: "r1", UserID: "u1", Nick: "  ", Kind: NoticeJoined, Text: "t", OccurredAt: now},
		"kind inválido":   {EventID: "e", Type: TypeNotice, RoomID: "r1", UserID: "u1", Nick: "Pedro", Kind: "typing", Text: "t", OccurredAt: now},
		"sin occurred":    {EventID: "e", Type: TypeNotice, RoomID: "r1", UserID: "u1", Nick: "Pedro", Kind: NoticeJoined, Text: "t"},
	}
	for name, m := range cases {
		if err := m.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil, want error", name)
		}
	}
}

func baseReactionSend() ReactionSend {
	return ReactionSend{
		EventID: "r1", Type: TypeReactionSend, RoomID: "room1",
		Emoji: "❤️", PositionMS: 12345, OccurredAt: time.Now().UTC(),
	}
}

func TestReactionSendOK(t *testing.T) {
	if err := baseReactionSend().Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
}

func TestReactionSendRejects(t *testing.T) {
	now := time.Now().UTC()
	cases := map[string]ReactionSend{
		"sin event_id":        {Type: TypeReactionSend, RoomID: "room1", Emoji: "❤️", OccurredAt: now},
		"tipo incorrecto":     {EventID: "e", Type: "chat_send", RoomID: "room1", Emoji: "❤️", OccurredAt: now},
		"sin sala":            {EventID: "e", Type: TypeReactionSend, Emoji: "❤️", OccurredAt: now},
		"emoji fuera del set": {EventID: "e", Type: TypeReactionSend, RoomID: "room1", Emoji: "💩", OccurredAt: now},
		"emoji vacío":         {EventID: "e", Type: TypeReactionSend, RoomID: "room1", Emoji: " ", OccurredAt: now},
		"posición negativa":   {EventID: "e", Type: TypeReactionSend, RoomID: "room1", Emoji: "❤️", PositionMS: -1, OccurredAt: now},
		"sin occurred":        {EventID: "e", Type: TypeReactionSend, RoomID: "room1", Emoji: "❤️"},
	}
	for name, m := range cases {
		if err := m.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil, want error", name)
		}
	}
}

func TestReactionSetIncluyeTristezaExtraAlDocumento(t *testing.T) {
	// REQ-20 fija 5; se suma 😢 (tristeza) por decisión de producto.
	want := map[string]bool{"👏": true, "😂": true, "😮": true, "😱": true, "❤️": true, "😢": true}
	if len(ReactionEmojis) != len(want) {
		t.Fatalf("len(ReactionEmojis) = %d, want %d", len(ReactionEmojis), len(want))
	}
	for _, e := range ReactionEmojis {
		if !want[e] {
			t.Errorf("emoji %q no está en el set esperado", e)
		}
	}
}

func TestReactionBroadcastValidate(t *testing.T) {
	now := time.Now().UTC()
	m := Reaction{
		EventID: "e", Type: TypeReaction, RoomID: "room1",
		UserID: "u1", Nick: "Ana", Emoji: "👏", PositionMS: 1000,
		OccurredAt: now, ReceivedAt: now,
	}
	if err := m.Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
	bad := m
	bad.Emoji = "💩"
	if err := bad.Validate(); err == nil {
		t.Errorf("emoji fuera del set: Validate() = nil, want error")
	}
}
