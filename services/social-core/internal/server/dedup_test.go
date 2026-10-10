package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// fakeBus imita a Redis: un solo canal por sala al que publican y del que
// cada suscriptor recibe TODO (incluido el eco propio).
type fakeBus struct {
	ch chan []byte
}

func newFakeBus() *fakeBus { return &fakeBus{ch: make(chan []byte, 128)} }

func (b *fakeBus) publish(_ context.Context, _ string, msg socialevent.ChatMessage) error {
	raw, _ := json.Marshal(msg)
	b.ch <- raw
	return nil
}

func (b *fakeBus) subscribe(ctx context.Context, _ string) (<-chan socialevent.ChatMessage, func()) {
	out := make(chan socialevent.ChatMessage, 64)
	stop := make(chan struct{})
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case <-stop:
				return
			case raw := <-b.ch:
				var m socialevent.ChatMessage
				if err := json.Unmarshal(raw, &m); err != nil {
					continue
				}
				select {
				case out <- m:
				default:
				}
			}
		}
	}()
	return out, func() { close(stop) }
}

func readOne(t *testing.T, c *websocket.Conn, timeout time.Duration) (map[string]any, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, raw, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	return m, nil
}

// Con N clientes en la sala y Pub/Sub cableado, 1 mensaje debe llegar
// exactamente 1 vez a cada cliente (sin eco N+1).
func TestSocialNoDuplicateWithPubSub(t *testing.T) {
	secret := "s3cr3t"
	bus := newFakeBus()
	deps := testDeps(secret)
	deps.Publish = bus.publish
	deps.Subscribe = bus.subscribe
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)
	a := dial(t, wsBase, guestToken(t, secret, "guest:a", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	b := dial(t, wsBase, guestToken(t, secret, "guest:b", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")

	if _, err := readOne(t, a, 5*time.Second); err != nil {
		t.Fatalf("A history: %v", err)
	}
	if m, err := readOne(t, a, 5*time.Second); err != nil {
		t.Fatalf("A notice propio: %v", err)
	} else if m["type"] != "notice" || m["kind"] != "joined" {
		t.Fatalf("A = %v, want notice joined", m)
	}
	if _, err := readOne(t, b, 5*time.Second); err != nil {
		t.Fatalf("B history: %v", err)
	}
	if m, err := readOne(t, b, 5*time.Second); err != nil {
		t.Fatalf("B notice propio: %v", err)
	} else if m["type"] != "notice" || m["kind"] != "joined" {
		t.Fatalf("B = %v, want notice joined", m)
	}
	if m, err := readOne(t, a, 5*time.Second); err != nil {
		t.Fatalf("A notice de B: %v", err)
	} else if m["type"] != "notice" || m["kind"] != "joined" {
		t.Fatalf("A = %v, want notice joined de B", m)
	}

	send := socialevent.ChatSend{
		EventID: "c1", Type: socialevent.TypeChatSend, RoomID: "r1",
		Text: "hola una vez", OccurredAt: time.Now().UTC(),
	}
	raw, _ := json.Marshal(send)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}

	for name, c := range map[string]*websocket.Conn{"A": a, "B": b} {
		got, err := readOne(t, c, 5*time.Second)
		if err != nil {
			t.Fatalf("%s primera copia: %v", name, err)
		}
		if got["type"] != "chat_message" {
			t.Fatalf("%s = %v, want chat_message", name, got)
		}
		// Ventana anti-eco: solo falla si llega OTRO chat_message. Un notice
		// de salida es legítimo (el check de 300ms del otro cliente autocierra
		// su conexión al expirar el contexto — así es nhooyr — y eso emite left).
		// Esa lectura con timeout es además la última en esta conexión.
		if m, err := readOne(t, c, 300*time.Millisecond); err == nil && m["type"] == "chat_message" {
			t.Fatalf("%s recibió el mensaje DUPLICADO (eco Pub/Sub): %v", name, m)
		}
	}
	_ = chat.HistoryKey
}
