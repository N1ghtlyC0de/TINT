package hub

import (
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/drift"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// syncCheck arma un SYNC_CHECK con la posición local del cliente.
func syncCheck(id string, pos int64) map[string]any {
	return cmd(id, syncevent.SyncCheck, pos)
}

// playingRoom conecta host e invitado y deja la sala reproduciendo desde 0
// en t0 (version 1).
func playingRoom(t *testing.T, e *env, h *Hub) (*Client, *Client) {
	t.Helper()
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)
	send(t, h, hc, cmd("e-play", syncevent.Play, 0))
	nextOf(t, g, syncevent.Play)
	return hc, g
}

// Un cliente en stall reporta la misma posición congelada en cada latido:
// sin enfriamiento, cada SYNC_CHECK producía otro seek (bucle seek→stall→seek).
func TestSeekCorrectionCooldown(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	_, g := playingRoom(t, e, h)

	// t0+10s: el maestro va en 10000 y el cliente sigue congelado en 0.
	e.clock.advance(10 * time.Second)
	send(t, h, g, syncCheck("c1", 0))
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "seek" {
		t.Fatalf("primera corrección = %+v, want seek", corr)
	}
	if e.tel.count() != 1 {
		t.Fatalf("telemetría = %d, want 1", e.tel.count())
	}

	// Dentro del enfriamiento (3 s) no se repite el seek ni se reporta.
	for i := 0; i < 2; i++ {
		e.clock.advance(time.Second)
		send(t, h, g, syncCheck("c-frozen", 0))
		expectSilence(t, g)
	}
	if e.tel.count() != 1 {
		t.Errorf("un seek suprimido no debe emitir telemetría: %d", e.tel.count())
	}

	// Una corrección por rate sí se permite durante el enfriamiento
	// (t0+12s: el maestro va en 12000; el cliente, 1000 atrasado).
	send(t, h, g, syncCheck("c-rate", 11_000))
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "rate" {
		t.Errorf("durante el enfriamiento rate sigue permitido: %+v", corr)
	}

	// Cumplidos 3 s desde el último seek, vuelve a corregir con seek.
	e.clock.advance(time.Duration(drift.SeekCooldownMs)*time.Millisecond - 2*time.Second)
	send(t, h, g, syncCheck("c-again", 0))
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "seek" {
		t.Errorf("tras el enfriamiento = %+v, want seek", corr)
	}
}

// El enfriamiento es por cliente: el seek de uno no silencia al otro.
func TestSeekCooldownIsPerClient(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	_, g := playingRoom(t, e, h)
	g2 := connect(t, h, guestTwo)
	next(t, g2)

	e.clock.advance(10 * time.Second)
	send(t, h, g, syncCheck("a", 0))
	nextOf(t, g, syncevent.SyncCorrection)
	send(t, h, g2, syncCheck("b", 0))
	if corr := nextOf(t, g2, syncevent.SyncCorrection); corr.Strategy != "seek" {
		t.Errorf("el otro cliente debe recibir su seek: %+v", corr)
	}
}
