package server

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/moderation"
)

func chatSend(t *testing.T, c *websocket.Conn, id, text string) {
	t.Helper()
	sendRaw(t, c, map[string]any{
		"event_id": id, "type": "chat_send", "room_id": "r1", "text": text,
		"occurred_at": time.Now().UTC(),
	})
}

func mutedIDs(m map[string]any) []string {
	raw, _ := m["muted_user_ids"].([]any)
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out
}

func TestChatSettingsOnJoinAndForbiddenForGuests(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	m := nextOfType(t, colG, "chat_settings")
	if m["slow_mode_s"] != float64(0) || m["muted_user_ids"] == nil || len(mutedIDs(m)) != 0 || m["room_id"] != "r1" {
		t.Fatalf("chat_settings al entrar = %v, want 0 y []", m)
	}

	sendRaw(t, g, map[string]any{"event_id": "s", "type": "chat_slow_mode", "seconds": 10})
	if m := nextOfType(t, colG, "error"); m["code"] != "FORBIDDEN" || m["event_id_ref"] != "s" {
		t.Fatalf("invitado activa modo lento = %v, want FORBIDDEN", m)
	}
	sendRaw(t, g, map[string]any{"event_id": "m", "type": "chat_mute", "user_id": "guest:caro", "muted": true})
	if m := nextOfType(t, colG, "error"); m["code"] != "FORBIDDEN" {
		t.Fatalf("invitado silencia = %v, want FORBIDDEN", m)
	}
}

func TestSlowModeAppliesToGuestsNotModerators(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	urlA, _ := redisReplica(t, mr, secret, clock, timers)
	urlB, _ := redisReplica(t, mr, secret, clock, &fakeTimers{})
	h, colH := joinCol(t, urlA, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	g, colG := joinCol(t, urlB, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "chat_settings")
	nextOfType(t, colG, "chat_settings")
	waitSubs(t, mr, chat.ChannelKey("r1"), 2)

	for _, bad := range []any{15, -1, "10", nil} {
		sendRaw(t, h, map[string]any{"event_id": "bad", "type": "chat_slow_mode", "seconds": bad})
		if m := nextOfType(t, colH, "error"); m["code"] != "INVALID_PAYLOAD" {
			t.Fatalf("seconds %v = %v, want INVALID_PAYLOAD", bad, m)
		}
	}
	sendRaw(t, h, map[string]any{"event_id": "s1", "type": "chat_slow_mode", "room_id": "r1", "seconds": 10})
	// El cambio llega a ambas réplicas una sola vez.
	for name, col := range map[string]*collector{"host": colH, "guest": colG} {
		if m := nextOfType(t, col, "chat_settings"); m["slow_mode_s"] != float64(10) {
			t.Fatalf("%s chat_settings = %v, want 10", name, m)
		}
		noneOfType(t, col, "chat_settings")
	}
	if v := mr.HGet(moderation.SettingsKey("r1"), "slow_mode_s"); v != "10" {
		t.Fatalf("slow_mode_s en Redis = %q", v)
	}

	chatSend(t, g, "c1", "uno")
	nextOfType(t, colG, "chat_message")
	nextOfType(t, colH, "chat_message")
	mr.FastForward(4 * time.Second)
	chatSend(t, g, "c2", "dos")
	m := nextOfType(t, colG, "error")
	if m["code"] != "SLOW_MODE" || m["retry_after_ms"] != float64(6000) || m["event_id_ref"] != "c2" {
		t.Fatalf("segundo mensaje = %v, want SLOW_MODE con retry_after_ms 6000", m)
	}
	noneOfType(t, colH, "chat_message")
	// El host está exento.
	for i := 0; i < 3; i++ {
		chatSend(t, h, "h", "host")
		nextOfType(t, colH, "chat_message")
	}
	mr.FastForward(6 * time.Second)
	chatSend(t, g, "c3", "tres")
	nextOfType(t, colG, "chat_message")
}

func TestMuteBlocksChatOnly(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "co-1", "Ana", "cohost", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "chat_settings")
	nextOfType(t, colG, "chat_settings")

	sendRaw(t, h, map[string]any{"event_id": "m0", "type": "chat_mute", "user_id": "", "muted": true})
	if m := nextOfType(t, colH, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("sin user_id = %v", m)
	}
	sendRaw(t, h, map[string]any{"event_id": "m0", "type": "chat_mute", "user_id": "guest:beto"})
	if m := nextOfType(t, colH, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("sin muted = %v", m)
	}
	sendRaw(t, h, map[string]any{"event_id": "m1", "type": "chat_mute", "user_id": "guest:beto", "muted": true})
	for name, col := range map[string]*collector{"host": colH, "guest": colG} {
		m := nextOfType(t, col, "chat_settings")
		if ids := mutedIDs(m); len(ids) != 1 || ids[0] != "guest:beto" {
			t.Fatalf("%s chat_settings = %v", name, m)
		}
	}
	chatSend(t, g, "c1", "hola")
	if m := nextOfType(t, colG, "error"); m["code"] != "MUTED" || m["event_id_ref"] != "c1" {
		t.Fatalf("silenciado escribe = %v, want MUTED", m)
	}
	// Puede seguir reaccionando.
	react(t, g, colG, "👏", 0)
	// Quien entra después ve el silencio en chat_settings.
	g2, colG2 := joinCol(t, url, guestTokenAs(t, secret, "guest:caro", "Caro", "r1", exp0()))
	defer g2.Close(websocket.StatusNormalClosure, "")
	if ids := mutedIDs(nextOfType(t, colG2, "chat_settings")); len(ids) != 1 {
		t.Fatalf("chat_settings al entrar = %v", ids)
	}

	sendRaw(t, h, map[string]any{"event_id": "m2", "type": "chat_mute", "user_id": "guest:beto", "muted": false})
	if ids := mutedIDs(nextOfType(t, colG, "chat_settings")); len(ids) != 0 {
		t.Fatalf("tras quitar silencio = %v", ids)
	}
	chatSend(t, g, "c2", "volví")
	nextOfType(t, colG, "chat_message")
}

func TestModerationUnavailableWithoutRedis(t *testing.T) {
	const secret = "s3cr3t"
	url := laserURL(t, testDeps(secret))
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	sendRaw(t, h, map[string]any{"event_id": "s", "type": "chat_slow_mode", "seconds": 5})
	if m := nextOfType(t, colH, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("modo lento sin Redis = %v", m)
	}
	sendRaw(t, h, map[string]any{"event_id": "m", "type": "chat_mute", "user_id": "u", "muted": true})
	if m := nextOfType(t, colH, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("silencio sin Redis = %v", m)
	}
	// El chat sigue funcionando sin moderación.
	chatSend(t, h, "c", "hola")
	nextOfType(t, colH, "chat_message")
}

// Con Redis caído no se puede comprobar el silencio: el chat de los
// participantes falla cerrado (UNAVAILABLE) en vez de dejar pasar.
func TestChatFailsClosedWhenModerationDown(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colG, "chat_settings")
	mr.Close()
	chatSend(t, g, "c1", "hola")
	if m := nextOfType(t, colG, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("chat con Redis caído = %v, want UNAVAILABLE", m)
	}
}
