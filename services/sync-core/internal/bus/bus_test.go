package bus

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

type delivery struct {
	room    string
	payload string
}

func newBus(t *testing.T, mr *miniredis.Miniredis) (*Bus, chan delivery) {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	got := make(chan delivery, 16)
	b := New(rdb)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	b.Start(ctx, func(room string, payload []byte) { got <- delivery{room, string(payload)} })
	t.Cleanup(func() { _ = b.Close() })
	return b, got
}

func waitSubscribers(t *testing.T, mr *miniredis.Miniredis, channel string, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mr.PubSubNumSub(channel)[channel] == n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("esperaba %d suscriptores en %s", n, channel)
}

func recv(t *testing.T, ch chan delivery) delivery {
	t.Helper()
	select {
	case d := <-ch:
		return d
	case <-time.After(2 * time.Second):
		t.Fatal("no llegó el mensaje")
		return delivery{}
	}
}

// Dos réplicas comparten Redis: lo publicado por A llega a los clientes de B.
func TestCrossReplicaDelivery(t *testing.T) {
	mr := miniredis.RunT(t)
	a, gotA := newBus(t, mr)
	b, gotB := newBus(t, mr)
	ctx := context.Background()

	if err := a.Subscribe(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if err := b.Subscribe(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	waitSubscribers(t, mr, "room:r1:sync", 2)

	if err := a.Publish(ctx, "r1", []byte("hola")); err != nil {
		t.Fatal(err)
	}
	for _, ch := range []chan delivery{gotA, gotB} {
		if d := recv(t, ch); d != (delivery{"r1", "hola"}) {
			t.Errorf("delivery = %+v", d)
		}
	}
}

func TestUnsubscribeStopsDelivery(t *testing.T) {
	mr := miniredis.RunT(t)
	a, gotA := newBus(t, mr)
	ctx := context.Background()

	if err := a.Subscribe(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if err := a.Subscribe(ctx, "r2"); err != nil {
		t.Fatal(err)
	}
	waitSubscribers(t, mr, "room:r2:sync", 1)
	if err := a.Unsubscribe(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	waitSubscribers(t, mr, "room:r1:sync", 0)

	mr.Publish("room:r1:sync", "ignorado")
	mr.Publish("room:r2:sync", "ok")
	if d := recv(t, gotA); d != (delivery{"r2", "ok"}) {
		t.Errorf("solo debe llegar r2, got %+v", d)
	}
}

func TestRoomFromChannel(t *testing.T) {
	tests := map[string]string{
		"room:abc:sync":       "abc",
		"room:a:b:sync":       "a:b",
		"otro":                "",
		"room:abc:sync_state": "",
	}
	for in, want := range tests {
		if got := roomFromChannel(in); got != want {
			t.Errorf("roomFromChannel(%q) = %q, want %q", in, got, want)
		}
	}
}
