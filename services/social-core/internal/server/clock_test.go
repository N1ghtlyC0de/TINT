package server

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// Un cliente con el reloj 2 s adelantado perdía su mensaje (INVALID_PAYLOAD,
// confirmado en vivo). Los relojes de cliente y servidor no se comparan: un
// occurred_at futuro se recorta a received_at.
func TestSocialAcceptsClientClockAhead(t *testing.T) {
	secret := "s3cr3t"
	fixed := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	deps := testDeps(secret)
	deps.Now = func() time.Time { return fixed }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	_ = readJSON(t, c) // notice joined propio

	ahead := fixed.Add(2 * time.Second)
	sendRaw(t, c, socialevent.ChatSend{
		EventID: "c1", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "hola", OccurredAt: ahead,
	})
	got := readJSON(t, c)
	if got["type"] != "chat_message" {
		t.Fatalf("chat con reloj adelantado = %v, want chat_message", got)
	}
	if got["occurred_at"] != got["received_at"] || got["received_at"] != fixed.Format(time.RFC3339Nano) {
		t.Fatalf("occurred_at = %v, received_at = %v, want ambos %v", got["occurred_at"], got["received_at"], fixed)
	}

	sendRaw(t, c, socialevent.ReactionSend{
		EventID: "r1", Type: socialevent.TypeReactionSend, RoomID: "r1", Emoji: "👏", OccurredAt: ahead,
	})
	got = readJSON(t, c)
	if got["type"] != "reaction" || got["occurred_at"] != got["received_at"] {
		t.Fatalf("reacción con reloj adelantado = %v, want reaction con occurred_at recortado", got)
	}

	// Un occurred_at en el pasado se conserva tal cual.
	past := fixed.Add(-3 * time.Second)
	sendRaw(t, c, socialevent.ChatSend{
		EventID: "c2", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "antes", OccurredAt: past,
	})
	got = readJSON(t, c)
	if got["occurred_at"] != past.Format(time.RFC3339Nano) {
		t.Fatalf("occurred_at pasado = %v, want %v", got["occurred_at"], past)
	}
}
