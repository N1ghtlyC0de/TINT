// SYNC-TEST-01 — Prueba de carga del Canal Sync (/ws/sync) con k6.
//
// N conexiones simultáneas (por defecto 500) a una misma sala. El VU 1 es el
// Host (role=host): envía PLAY al conectar y un SEEK cada SEEK_EVERY. El resto
// son participantes que responden cada HEARTBEAT con un SYNC_CHECK cuya
// posición se calcula a partir del ancla del Reloj Maestro, igual que el
// reproductor web. Así el drift esperado es bajo y la prueba mide el canal,
// no un reproductor simulado defectuoso.
//
// sync_drift_ms: el servidor solo responde SYNC_CORRECTION cuando
// |drift| > 500 ms; cada SYNC_CHECK que no recibe corrección antes del
// siguiente HEARTBEAT se registra como 0. Así p(99)<500 significa "menos del
// 1 % de los chequeos necesitó corrección".
//
// Uso: k6 run -e ROOM_ID=sala-carga services/sync-core/loadtest/sync.js
// Ver services/sync-core/loadtest/README.md.

import ws from 'k6/ws';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'ws://localhost:8082';
const ROOM_ID = __ENV.ROOM_ID || `loadtest-${Date.now()}`;
const VUS = parseInt(__ENV.VUS || '500', 10);
const DURATION = __ENV.DURATION || '60s';
const JWT_SECRET = __ENV.JWT_SECRET || 'dev-secret-change-in-prod';
const JWT_ISSUER = __ENV.JWT_ISSUER || 'tint-identity';
const JWT_AUDIENCE = __ENV.JWT_AUDIENCE || 'tint:room';
const SEEK_EVERY = __ENV.SEEK_EVERY || '10s';
// Cada participante intenta una vez un comando (PAUSE) para verificar que el
// servidor responde FORBIDDEN. Desactivar con -e PROBE_FORBIDDEN=false.
const PROBE_FORBIDDEN = (__ENV.PROBE_FORBIDDEN || 'true') !== 'false';

const HOLD_MS = durationMs(DURATION);

export const options = {
  scenarios: {
    sync: {
      // Una iteración por VU: cada VU mantiene una conexión durante DURATION.
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: `${Math.ceil(HOLD_MS / 1000) + 60}s`,
    },
  },
  thresholds: {
    sync_broadcast_latency_ms: ['p(99)<100'],
    sync_drift_ms: ['p(99)<500'],
    ws_connecting: ['p(95)<1000'],
    sync_forbidden_errors: ['rate>0.99'],
    checks: ['rate>0.99'],
  },
};

const broadcastLatency = new Trend('sync_broadcast_latency_ms', true);
const driftMs = new Trend('sync_drift_ms', true);
const corrections = new Counter('sync_corrections');
const forbiddenErrors = new Rate('sync_forbidden_errors');
const serverErrors = new Counter('sync_server_errors');

// setup genera un token HS256 por VU (mismo formato que identity-api).
export function setup() {
  const exp = Math.floor(Date.now() / 1000) + Math.ceil(HOLD_MS / 1000) + 3600;
  const tokens = [];
  for (let vu = 1; vu <= VUS; vu++) {
    const host = vu === 1;
    tokens.push(
      signJWT({
        sub: host ? 'loadtest-host' : `loadtest-user-${vu}`,
        room_id: ROOM_ID,
        role: host ? 'host' : 'participant',
        nick: host ? 'Host' : `Espectador ${vu}`,
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        exp,
      }),
    );
  }
  return { tokens };
}

export default function (data) {
  const isHost = __VU === 1;
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const url = `${BASE_URL}/ws/sync?room_id=${encodeURIComponent(ROOM_ID)}&token=${token}`;

  const res = ws.connect(url, null, (socket) => {
    // Ancla local del Reloj Maestro (última versión aplicada).
    let anchor = null;
    let started = false;
    let probeID = null;
    let probeScheduled = false;
    // true mientras el último SYNC_CHECK no haya recibido corrección.
    let checkPending = false;

    const send = (msg) => socket.send(JSON.stringify(msg));
    const command = (type, positionMs) => {
      const id = uuidv4();
      send({
        event_id: id,
        type,
        room_id: ROOM_ID,
        position_ms: Math.max(0, Math.round(positionMs)),
        occurred_at: new Date().toISOString(),
      });
      return id;
    };

    // Posición esperada del reproductor ahora, usando solo diferencias del
    // reloj del servidor más el tiempo local transcurrido desde la recepción.
    const expectedPosition = () => {
      if (!anchor) return 0;
      if (anchor.status !== 'playing') return anchor.positionMs;
      const elapsed = Date.now() - anchor.localRecvMs + anchor.serverOffsetMs;
      return anchor.positionMs + elapsed * anchor.rate;
    };

    const applyAnchor = (msg) => {
      if (anchor && msg.version < anchor.version) return false; // obsoleto
      anchor = {
        version: msg.version,
        status: msg.status,
        positionMs: msg.position_ms,
        rate: msg.rate || 1,
        localRecvMs: Date.now(),
        serverOffsetMs: (msg.server_time_ms || 0) - (msg.updated_at_ms || 0),
      };
      return true;
    };

    socket.on('message', (raw) => {
      const now = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        serverErrors.add(1, { reason: 'json' });
        return;
      }

      switch (msg.type) {
        case 'STATE':
          applyAnchor(msg);
          if (isHost && !started) {
            started = true;
            command('PLAY', expectedPosition());
            socket.setInterval(() => {
              command('SEEK', expectedPosition() + 5000);
            }, durationMs(SEEK_EVERY));
          }
          if (!isHost && PROBE_FORBIDDEN && !probeScheduled) {
            probeScheduled = true;
            // Retraso aleatorio para no concentrar los 499 intentos.
            socket.setTimeout(() => {
              probeID = command('PAUSE', expectedPosition());
            }, 1000 + Math.random() * 4000);
          }
          break;

        case 'PLAY':
        case 'PAUSE':
        case 'SEEK':
          if (!isHost && msg.occurred_at) {
            const sentAt = parseTime(msg.occurred_at);
            if (!isNaN(sentAt)) broadcastLatency.add(now - sentAt, { type: msg.type });
          }
          applyAnchor(msg);
          break;

        case 'HEARTBEAT':
          // El servidor solo responde si |drift| > 500 ms: un SYNC_CHECK sin
          // corrección antes del siguiente latido cuenta como drift 0.
          if (checkPending) driftMs.add(0);
          checkPending = true;
          send({
            event_id: uuidv4(),
            type: 'SYNC_CHECK',
            room_id: ROOM_ID,
            position_ms: Math.max(0, Math.round(expectedPosition())),
            echo_server_ts: msg.server_time_ms,
            occurred_at: new Date().toISOString(),
          });
          break;

        case 'SYNC_CORRECTION':
          corrections.add(1, { strategy: msg.strategy });
          driftMs.add(Math.abs(msg.drift_ms || 0));
          checkPending = false;
          if (anchor && msg.version >= anchor.version) {
            // Realinear el reproductor simulado a target_ms.
            anchor.positionMs = msg.target_ms;
            anchor.localRecvMs = now;
            anchor.serverOffsetMs = 0;
          }
          break;

        case 'ACK':
          if (probeID && msg.ref_event_id === probeID) {
            forbiddenErrors.add(false); // un participante pudo controlar: fallo de autorización
            probeID = 'done';
          }
          break;

        case 'ERROR':
          if (probeID && msg.ref_event_id === probeID && msg.code === 'FORBIDDEN') {
            forbiddenErrors.add(true);
            probeID = 'done';
          } else {
            serverErrors.add(1, { code: msg.code || 'unknown' });
          }
          break;

        default:
          break; // HOST_STATUS y futuros tipos
      }
    });

    socket.on('error', (e) => {
      serverErrors.add(1, { reason: 'socket' });
      console.error(`VU ${__VU}: ${e.error ? e.error() : e}`);
    });

    socket.setTimeout(() => socket.close(), HOLD_MS);
  });

  check(res, { 'handshake 101': (r) => r && r.status === 101 });
}

// ---------------------------------------------------------------------------

function signJWT(claims) {
  const header = encoding.b64encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'rawurl');
  const payload = encoding.b64encode(JSON.stringify(claims), 'rawurl');
  const signature = crypto.hmac('sha256', JWT_SECRET, `${header}.${payload}`, 'base64rawurl');
  return `${header}.${payload}.${signature}`;
}

function uuidv4() {
  const b = new Uint8Array(crypto.randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Go serializa time.Time en RFC3339Nano; se recorta a milisegundos para Date.
function parseTime(s) {
  return Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
}

function durationMs(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(s).trim());
  if (!m) throw new Error(`duración inválida: ${s}`);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]];
  return Math.round(parseFloat(m[1]) * mult);
}
