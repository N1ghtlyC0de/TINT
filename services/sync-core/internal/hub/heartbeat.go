package hub

import (
	"bytes"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// heartbeatTmpl arma el HEARTBEAT JSON de todos los clientes de una sala en
// un mismo tick. Lo común (tipo, sala, timestamps, server_time_ms) lo
// serializa encoding/json una vez; por cliente solo se añaden event_id,
// drift_ms y rtt_ms. Con 500 clientes evita 500 json.Marshal por reflexión
// cada segundo. El resultado es idéntico byte a byte al de json.Marshal
// (ver TestHeartbeatTemplateMatchesJSON).
type heartbeatTmpl struct {
	// mid va tras el valor de event_id: `,"type":"HEARTBEAT",…,"server_time_ms":N`.
	mid []byte
}

const heartbeatHead = `{"event_id":""`

func newHeartbeatTmpl(room string, now time.Time) heartbeatTmpl {
	raw := mustJSON(syncevent.Event{
		Type: syncevent.Heartbeat, RoomID: room, OccurredAt: now, ReceivedAt: now, ServerTimeMs: now.UnixMilli(),
	})
	// raw = {"event_id":"" + mid + }
	return heartbeatTmpl{mid: bytes.Clone(raw[len(heartbeatHead) : len(raw)-1])}
}

// encode devuelve el HEARTBEAT de un cliente. El UUID (solo hexadecimal y
// guiones) se escribe directo en el buffer: no necesita escaparse ni un
// string intermedio. En Event, drift_ms va antes que rtt_ms y ambos se
// omiten si valen 0.
func (t heartbeatTmpl) encode(id uuid.UUID, driftMs, rttMs int64) []byte {
	buf := make([]byte, 0, len(heartbeatHead)+36+len(t.mid)+48)
	buf = append(buf, `{"event_id":"`...)
	buf = appendUUID(buf, id)
	buf = append(buf, '"')
	buf = append(buf, t.mid...)
	if driftMs != 0 {
		buf = append(buf, `,"drift_ms":`...)
		buf = strconv.AppendInt(buf, driftMs, 10)
	}
	if rttMs != 0 {
		buf = append(buf, `,"rtt_ms":`...)
		buf = strconv.AppendInt(buf, rttMs, 10)
	}
	return append(buf, '}')
}

// appendUUID escribe id en su forma canónica (la de uuid.UUID.String).
func appendUUID(buf []byte, id uuid.UUID) []byte {
	const hexDigits = "0123456789abcdef"
	for i, b := range id {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			buf = append(buf, '-')
		}
		buf = append(buf, hexDigits[b>>4], hexDigits[b&0x0f])
	}
	return buf
}
