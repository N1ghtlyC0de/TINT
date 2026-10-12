package hub

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// El HEARTBEAT JSON se arma con una plantilla por sala y tick; debe ser
// byte a byte lo que produciría encoding/json con el mismo evento.
func TestHeartbeatTemplateMatchesJSON(t *testing.T) {
	rooms := []string{"room-1", `sa<la>&"x\` + "\u2028ñ", ""}
	nows := []time.Time{t0, t0.Add(123456789 * time.Nanosecond), time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("x", -5*3600))}
	vals := [][2]int64{{0, 0}, {-620, 35}, {5, 0}, {0, 7}, {9_223_372_036_854_775_807, -1}}
	for _, room := range rooms {
		for _, now := range nows {
			tmpl := newHeartbeatTmpl(room, now)
			for _, v := range vals {
				id := uuid.New()
				want, err := json.Marshal(syncevent.Event{
					EventID: id.String(), Type: syncevent.Heartbeat, RoomID: room, OccurredAt: now, ReceivedAt: now,
					ServerTimeMs: now.UnixMilli(), DriftMs: v[0], RTTMs: v[1],
				})
				if err != nil {
					t.Fatal(err)
				}
				if got := tmpl.encode(id, v[0], v[1]); string(got) != string(want) {
					t.Errorf("room %q drift/rtt %v:\n got %s\nwant %s", room, v, got, want)
				}
			}
		}
	}
}
