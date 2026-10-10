import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { Correction } from '../lib/drift';
import {
  backoffDelay,
  buildCommand,
  buildSyncCheck,
  buildSyncUrl,
  CLOSE_REVOKED,
  estimateServerNow,
  expectedPosition,
  parseServerMessage,
  type CommandExtra,
  type CommandType,
  type SyncSnapshot,
  type SyncState,
} from '../lib/syncProtocol';

export const DEFAULT_SYNC_WS_URL = 'ws://localhost:8082/ws/sync';

/** Longitud máxima de `media_id` aceptada por sync-core (contrato v2 §2). */
const MAX_MEDIA_ID = 128;
/** Cuántos event_id propios recordamos para reconocer sus broadcasts. */
const OWN_EVENTS_MEMORY = 50;

export type SyncRole = 'host' | 'guest';

export interface UseSyncSocketOptions {
  roomId: string;
  /** host → pide un sync-ticket en identity-api; guest → usa tint_guest_token. */
  role: SyncRole;
  /** Posición local actual en ms (p. ej. del <video>); null si no hay reproductor. */
  getPositionMs?: () => number | null;
  /** URL base del canal; por defecto VITE_SYNC_WS_URL. */
  url?: string;
  /** Reloj monotónico local (inyectable para pruebas). */
  now?: () => number;
}

export interface SyncCorrection extends Correction {
  /** Secuencia local: cambia en cada corrección recibida, aunque se repitan valores. */
  seq: number;
  version: number;
}

/** Último broadcast de comando aceptado (para avisos y marcadores de saltos). */
export interface SyncBroadcast {
  seq: number;
  type: CommandType;
  event_id?: string;
  position_ms: number;
  rate: number;
  media_id: string;
  /** true si lo emitió este cliente (event_id devuelto por sendCommand). */
  own: boolean;
}

export interface ReconnectInfo {
  /** Número del próximo intento (1, 2, 3…). */
  attempt: number;
  /** Instante (Date.now) del próximo intento. */
  nextRetryAt: number;
}

export interface SyncSocketApi {
  connected: boolean;
  state: SyncSnapshot | null;
  hostOnline: boolean | null;
  /** Código del último error (ERROR del servidor, 'TICKET' o 'NO_TOKEN'). */
  lastError: string | null;
  correction: SyncCorrection | null;
  /** Si este cliente puede emitir comandos (STATE.can_control / CONTROL; host antes del 1.er STATE). */
  canControl: boolean;
  /** RTT suavizado medido por el servidor (HEARTBEAT.rtt_ms). */
  rttMs: number | null;
  /** Último drift conocido (HEARTBEAT.drift_ms o SYNC_CORRECTION). */
  driftMs: number | null;
  /** El token fue revocado por el host (cierre 4001): no se reconecta. */
  revoked: boolean;
  /** Reintento programado, o null si conectado / sin reintento. */
  reconnect: ReconnectInfo | null;
  lastBroadcast: SyncBroadcast | null;
  /**
   * Envía PLAY/PAUSE/SEEK/RATE/LOAD si este cliente tiene el control.
   * Devuelve el event_id o null si no se envió.
   */
  sendCommand: (type: CommandType, positionMs: number, extra?: CommandExtra) => string | null;
}

interface SyncTicket {
  token: string;
  expiresAt: string;
}

const defaultNow = () => performance.now();

function validExtra(type: CommandType, extra: CommandExtra): boolean {
  if (type === 'RATE') return typeof extra.rate === 'number' && Number.isFinite(extra.rate);
  if (type === 'LOAD') {
    return typeof extra.media_id === 'string' && extra.media_id.length > 0 && extra.media_id.length <= MAX_MEDIA_ID;
  }
  return true;
}

/**
 * Cliente del Canal Sync (/ws/sync de sync-core). Solo refleja el estado maestro:
 * filtra broadcasts por versión, responde heartbeats y expone las correcciones que
 * decide el servidor. Reconecta con backoff exponencial mientras esté montado, salvo
 * si el servidor cierra con 4001 (token revocado).
 */
export function useSyncSocket({
  roomId,
  role,
  getPositionMs,
  url,
  now,
}: UseSyncSocketOptions): SyncSocketApi {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<SyncSnapshot | null>(null);
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [correction, setCorrection] = useState<SyncCorrection | null>(null);
  // Respaldo antes del primer STATE: el host controla; luego decide el servidor.
  const [canControl, setCanControl] = useState(role === 'host');
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [driftMs, setDriftMs] = useState<number | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [reconnect, setReconnect] = useState<ReconnectInfo | null>(null);
  const [lastBroadcast, setLastBroadcast] = useState<SyncBroadcast | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<SyncSnapshot | null>(null);
  const canControlRef = useRef(canControl);
  const ownEventsRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const broadcastSeqRef = useRef(0);
  const getPositionRef = useRef(getPositionMs);
  const nowRef = useRef(now ?? defaultNow);

  useEffect(() => {
    getPositionRef.current = getPositionMs;
    nowRef.current = now ?? defaultNow;
  });

  const baseUrl = url || import.meta.env.VITE_SYNC_WS_URL || DEFAULT_SYNC_WS_URL;

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | null = null;

    const applyControl = (value: boolean) => {
      canControlRef.current = value;
      setCanControl(value);
    };
    applyControl(role === 'host');

    const acceptState = (s: SyncState) => {
      const snapshot: SyncSnapshot = {
        status: s.status,
        position_ms: s.position_ms,
        updated_at_ms: s.updated_at_ms,
        rate: s.rate,
        version: s.version,
        server_time_ms: s.server_time_ms,
        media_id: s.media_id ?? '',
        received_at_perf: nowRef.current(),
      };
      stateRef.current = snapshot;
      setState(snapshot);
      return snapshot;
    };

    const currentPosition = (): number => {
      const local = getPositionRef.current?.() ?? null;
      if (local !== null) return local;
      const snap = stateRef.current;
      if (!snap) return 0;
      return expectedPosition(snap, estimateServerNow(snap, nowRef.current()));
    };

    const handleMessage = (ws: WebSocket, raw: string) => {
      const msg = parseServerMessage(raw);
      if (!msg) return;
      switch (msg.type) {
        case 'STATE':
          // Snapshot completo: siempre reemplaza (p. ej. tras reconectar).
          acceptState(msg);
          if (typeof msg.online === 'boolean') setHostOnline(msg.online);
          if (typeof msg.can_control === 'boolean') applyControl(msg.can_control);
          break;
        case 'PLAY':
        case 'PAUSE':
        case 'SEEK':
        case 'RATE':
        case 'LOAD': {
          if (stateRef.current && msg.version <= stateRef.current.version) break;
          const snap = acceptState(msg);
          broadcastSeqRef.current += 1;
          setLastBroadcast({
            seq: broadcastSeqRef.current,
            type: msg.type,
            event_id: msg.event_id,
            position_ms: snap.position_ms,
            rate: snap.rate,
            media_id: snap.media_id,
            own: !!msg.event_id && ownEventsRef.current.includes(msg.event_id),
          });
          break;
        }
        case 'CONTROL':
          applyControl(msg.can_control);
          break;
        case 'HEARTBEAT':
          if (typeof msg.rtt_ms === 'number') {
            setRttMs(msg.rtt_ms);
            // v2 omite drift_ms cuando vale 0.
            setDriftMs(typeof msg.drift_ms === 'number' ? msg.drift_ms : 0);
          }
          ws.send(JSON.stringify(buildSyncCheck(roomId, currentPosition(), msg.server_time_ms)));
          break;
        case 'SYNC_CORRECTION':
          if (stateRef.current && msg.version < stateRef.current.version) break;
          seqRef.current += 1;
          setDriftMs(msg.drift_ms);
          setCorrection({
            seq: seqRef.current,
            target_ms: msg.target_ms,
            strategy: msg.strategy,
            drift_ms: msg.drift_ms,
            version: msg.version,
          });
          break;
        case 'HOST_STATUS':
          setHostOnline(msg.online);
          break;
        case 'ACK':
          setLastError(null);
          break;
        case 'ERROR':
          setLastError(msg.code);
          break;
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = backoffDelay(attempt);
      attempt += 1;
      setReconnect({ attempt, nextRetryAt: Date.now() + delay });
      timer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (role === 'guest') {
        // El guest token ya está en localStorage: conexión síncrona.
        openSocket(localStorage.getItem('tint_guest_token'));
        return;
      }
      // Ticket fresco en cada (re)conexión: son de vida corta.
      apiFetch(`/rooms/${encodeURIComponent(roomId)}/sync-ticket`, { method: 'POST' })
        .then((ticket: SyncTicket) => {
          if (!disposed) openSocket(ticket.token);
        })
        .catch(() => {
          if (disposed) return;
          setLastError('TICKET');
          scheduleReconnect();
        });
    };

    const openSocket = (token: string | null) => {
      if (!token) {
        setLastError('NO_TOKEN');
        setReconnect(null);
        return;
      }
      const ws = new WebSocket(buildSyncUrl(baseUrl, roomId, token));
      socket = ws;
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        setReconnect(null);
        setLastError(null);
      };
      ws.onmessage = (ev: MessageEvent) => handleMessage(ws, String(ev.data));
      // El cierre posterior se encarga de reconectar.
      ws.onerror = () => {};
      ws.onclose = (ev: CloseEvent) => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        if (ev.code === CLOSE_REVOKED) {
          // El host retiró a este participante: no reconectar nunca.
          if (role === 'guest') localStorage.removeItem('tint_guest_token');
          setRevoked(true);
          setReconnect(null);
          return;
        }
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close();
      }
      wsRef.current = null;
    };
  }, [roomId, role, baseUrl]);

  const sendCommand = useCallback(
    (type: CommandType, positionMs: number, extra: CommandExtra = {}): string | null => {
      if (!canControlRef.current) return null;
      if (!validExtra(type, extra)) return null;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return null;
      const cmd = buildCommand(type, roomId, positionMs, new Date(), extra);
      ws.send(JSON.stringify(cmd));
      ownEventsRef.current = [...ownEventsRef.current.slice(-(OWN_EVENTS_MEMORY - 1)), cmd.event_id];
      return cmd.event_id;
    },
    [roomId],
  );

  return {
    connected,
    state,
    hostOnline,
    lastError,
    correction,
    canControl,
    rttMs,
    driftMs,
    revoked,
    reconnect,
    lastBroadcast,
    sendCommand,
  };
}
