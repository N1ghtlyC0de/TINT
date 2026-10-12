package server

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// Un chat_send con spoiler llega marcado a la sala y queda así en el
// historial; sin el campo, el mensaje sale sin "spoiler" (retrocompatible).
func TestChatSpoilerBroadcastAndHistory(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")

	sendRaw(t, g, map[string]any{
		"event_id": "c1", "type": "chat_send", "room_id": "r1", "text": "muere al final",
		"spoiler": true, "occurred_at": clock.Now(),
	})
	if m := nextOfType(t, colG, "chat_message"); m["spoiler"] != true {
		t.Fatalf("chat_message = %v, want spoiler true", m)
	}
	sendRaw(t, g, socialevent.ChatSend{
		EventID: "c2", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "hola", OccurredAt: clock.Now(),
	})
	if m := nextOfType(t, colG, "chat_message"); m["spoiler"] != nil {
		t.Fatalf("chat_message sin spoiler = %v, want sin el campo", m)
	}

	c := dial(t, url, guestTokenAs(t, secret, "guest:caro", "Caro", "r1", exp0()))
	defer c.Close(websocket.StatusNormalClosure, "")
	col := collectConn(c)
	hist, ok := col.next(5 * time.Second)
	if !ok || hist["type"] != "history" {
		t.Fatalf("primer mensaje = %v", hist)
	}
	msgs, _ := hist["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("historial = %v", msgs)
	}
	first, _ := msgs[0].(map[string]any)
	second, _ := msgs[1].(map[string]any)
	if first["spoiler"] != true || second["spoiler"] != nil {
		t.Fatalf("historial = %v, want spoiler solo en el primero", msgs)
	}
}
