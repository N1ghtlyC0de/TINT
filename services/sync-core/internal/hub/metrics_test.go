package hub

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

func scrape(h *Hub) string {
	var b strings.Builder
	h.Registry().Write(&b)
	return b.String()
}

func TestMetrics(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g, err := h.Connect(context.Background(), guest)
	if err != nil {
		t.Fatal(err)
	}
	next(t, g)

	send(t, h, hc, cmd("e1", syncevent.Play, 0))
	collect(t, hc, syncevent.Ack, syncevent.Play)
	send(t, h, hc, cmd("e1", syncevent.Play, 0)) // duplicado
	nextOf(t, hc, syncevent.Ack)
	send(t, h, g, cmd("e2", syncevent.Pause, 0)) // prohibido
	nextOf(t, g, syncevent.Error)
	h.Handle(context.Background(), g, []byte("no-json"))
	nextOf(t, g, syncevent.Error)

	e.clock.advance(10 * time.Second)
	send(t, h, g, cmd("c", syncevent.SyncCheck, 0)) // muy atrasado → seek
	nextOf(t, g, syncevent.SyncCorrection)
	h.Disconnect(g)

	out := scrape(h)
	for _, want := range []string{
		"sync_connections 1",
		"sync_rooms 1",
		`sync_commands_total{result="ok"} 1`,
		`sync_commands_total{result="duplicate"} 1`,
		`sync_commands_total{result="forbidden"} 1`,
		`sync_messages_invalid_total 1`,
		`sync_disconnects_total{reason="normal"} 1`,
		`sync_corrections_total{strategy="seek"} 1`,
		"sync_command_apply_seconds_count 2",
		"sync_broadcast_delivery_seconds_count 1",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("falta %q en:\n%s", want, out)
		}
	}
}
