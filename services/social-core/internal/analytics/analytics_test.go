package analytics

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

var (
	occurred = time.Date(2026, 10, 11, 4, 29, 49, 368_000_000, time.FixedZone("COT", -5*3600))
	received = time.Date(2026, 10, 11, 9, 29, 49, 411_999_999, time.UTC)
)

func newTestEmitter(t *testing.T, buffer int) (*Emitter, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return New(client, buffer), client
}

func onlyEntry(t *testing.T, client *redis.Client) map[string]any {
	t.Helper()
	entries, err := client.XRange(context.Background(), StreamKey, "-", "+").Result()
	if err != nil {
		t.Fatalf("XRange: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entradas = %d, want 1", len(entries))
	}
	return entries[0].Values
}

func assertFields(t *testing.T, got map[string]any, want map[string]string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("campos = %v, want exactamente %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s = %v, want %q (evento %v)", k, got[k], v, got)
		}
	}
}

func TestFormatTimeIsUTCWithMillis(t *testing.T) {
	if got := FormatTime(occurred); got != "2026-10-11T09:29:49.368Z" {
		t.Fatalf("FormatTime = %q", got)
	}
	if got := FormatTime(received); got != "2026-10-11T09:29:49.411Z" {
		t.Fatalf("FormatTime trunca a ms = %q", got)
	}
}

func TestEmitChatWritesFlatFieldsWithoutText(t *testing.T) {
	e, client := newTestEmitter(t, 4)
	if !e.EmitChat(ChatMessage{
		EventID: "ev-1", RoomID: "room-1", UserID: "guest:abc", MessageLength: 17,
		OccurredAt: occurred, ReceivedAt: received,
	}) {
		t.Fatal("EmitChat debe encolar")
	}
	e.drain(context.Background())
	assertFields(t, onlyEntry(t, client), map[string]string{
		"event_id": "ev-1", "type": "chat_message", "source": "social-core",
		"room_id": "room-1", "user_id": "guest:abc", "message_length": "17",
		"occurred_at": "2026-10-11T09:29:49.368Z", "received_at": "2026-10-11T09:29:49.411Z",
	})
}

func TestEmitPresence(t *testing.T) {
	e, client := newTestEmitter(t, 4)
	e.EmitPresence(Presence{
		EventID: "ev-2", RoomID: "room-1", UserID: "uid-host", Kind: PresenceLeft,
		ConnectedUsers: 3, OccurredAt: received, ReceivedAt: received,
	})
	e.drain(context.Background())
	assertFields(t, onlyEntry(t, client), map[string]string{
		"event_id": "ev-2", "type": "presence", "source": "social-core",
		"room_id": "room-1", "user_id": "uid-host", "kind": "left", "connected_users": "3",
		"occurred_at": "2026-10-11T09:29:49.411Z", "received_at": "2026-10-11T09:29:49.411Z",
	})
}

func TestEmitReaction(t *testing.T) {
	e, client := newTestEmitter(t, 4)
	e.EmitReaction(Reaction{
		EventID: "ev-3", RoomID: "room-1", UserID: "guest:x", Emoji: "👏",
		PositionMS: 12000, OccurredAt: occurred, ReceivedAt: received,
	})
	e.drain(context.Background())
	assertFields(t, onlyEntry(t, client), map[string]string{
		"event_id": "ev-3", "type": "reaction", "source": "social-core",
		"room_id": "room-1", "user_id": "guest:x", "emoji": "👏", "position_ms": "12000",
		"occurred_at": "2026-10-11T09:29:49.368Z", "received_at": "2026-10-11T09:29:49.411Z",
	})
}

// Con el buffer lleno se descarta y se cuenta: nunca se bloquea al usuario.
func TestEmitDropsWhenBufferFull(t *testing.T) {
	e, _ := newTestEmitter(t, 1)
	if !e.EmitChat(ChatMessage{EventID: "a"}) {
		t.Fatal("primer evento debe entrar")
	}
	if e.EmitReaction(Reaction{EventID: "b"}) || e.EmitPresence(Presence{EventID: "c"}) {
		t.Fatal("con buffer lleno debe descartar")
	}
	if e.Dropped() != 2 {
		t.Fatalf("Dropped = %d, want 2", e.Dropped())
	}
}

// fakeXAdd captura los argumentos del XADD y puede fallar.
type fakeXAdd struct {
	redis.Cmdable
	args []*redis.XAddArgs
	err  error
}

func (f *fakeXAdd) XAdd(ctx context.Context, a *redis.XAddArgs) *redis.StringCmd {
	f.args = append(f.args, a)
	cmd := redis.NewStringCmd(ctx)
	if f.err != nil {
		cmd.SetErr(f.err)
	}
	return cmd
}

// El stream se acota con MAXLEN ~ 100000 (aproximado, barato para Redis).
func TestXAddUsesApproxMaxLen(t *testing.T) {
	f := &fakeXAdd{}
	e := New(f, 2)
	e.EmitChat(ChatMessage{EventID: "a"})
	e.drain(context.Background())
	if len(f.args) != 1 {
		t.Fatalf("XADD = %d, want 1", len(f.args))
	}
	a := f.args[0]
	if a.Stream != StreamKey || a.MaxLen != 100_000 || !a.Approx {
		t.Fatalf("XAddArgs = %+v, want analytics:events MAXLEN ~ 100000", a)
	}
	if e.Failed() != 0 {
		t.Fatalf("Failed = %d, want 0", e.Failed())
	}
}

func TestXAddFailureIsCounted(t *testing.T) {
	e := New(&fakeXAdd{err: errors.New("redis caído")}, 2)
	e.EmitChat(ChatMessage{EventID: "a"})
	e.drain(context.Background())
	if e.Failed() != 1 {
		t.Fatalf("Failed = %d, want 1", e.Failed())
	}
}

func TestRunWritesUntilCancelled(t *testing.T) {
	e, client := newTestEmitter(t, 4)
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() { e.Run(ctx); close(stopped) }()
	e.EmitChat(ChatMessage{EventID: "run-1", RoomID: "r"})
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for client.XLen(context.Background(), StreamKey).Val() != 1 {
		select {
		case <-deadline:
			t.Fatal("Run no escribió el evento")
		case <-tick.C:
		}
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Run no terminó al cancelar")
	}
}
