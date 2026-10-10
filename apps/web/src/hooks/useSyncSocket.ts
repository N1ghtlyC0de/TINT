import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { Correction } from '../lib/drift';
import {
  backoffDelay,
  buildCommand,
  buildSyncCheck,
  buildSyncUrl,
  estimateServerNow,
  expectedPosition,
  parseServerMessage,
  type CommandType,
  type SyncSnapshot,
  type SyncState,
} from '../lib/syncProtocol';

export const DEFAULT_SYNC_WS_URL = 'ws://localhost:8082/ws/sync';

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

export interface SyncSocketApi {
  connected: boolean;
  state: SyncSnapshot | null;
  hostOnline: boolean | null;
  /** Código del último error (ERROR del servidor, 'TICKET' o 'NO_TOKEN'). */
  lastError: string | null;
  correction: SyncCorrection | null;
  /** Envía PLAY/PAUSE/SEEK (solo host). Devuelve el event_id o null si no se envió. */
  sendCommand: (type: CommandType, positionMs: number) => string | null;
}

interface SyncTicket {
  token: string;
  expiresAt: string;
}

const defaultNow = () => performance.now();

/**
 * Cliente del Canal Sync (/ws/sync de sync-core). Solo refleja el estado maestro:
 * filtra broadcasts por versión, responde heartbeats y expone las correcciones que
 * decide el servidor. Reconecta con backoff exponencial mientras esté montado.
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

  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<SyncSnapshot | null>(null);
  const seqRef = useRef(0);
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

    const acceptState = (s: SyncState) => {
      const snapshot: SyncSnapshot = {
        status: s.status,
        position_ms: s.position_ms,
        updated_at_ms: s.updated_at_ms,
        rate: s.rate,
        version: s.version,
        server_time_ms: s.server_time_ms,
        received_at_perf: nowRef.current(),
      };
      stateRef.current = snapshot;
      setState(snapshot);
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
          break;
        case 'PLAY':
        case 'PAUSE':
        case 'SEEK':
          if (!stateRef.current || msg.version > stateRef.current.version) acceptState(msg);
          break;
        case 'HEARTBEAT':
          ws.send(JSON.stringify(buildSyncCheck(roomId, currentPosition(), msg.server_time_ms)));
          break;
        case 'SYNC_CORRECTION':
          if (stateRef.current && msg.version < stateRef.current.version) break;
          seqRef.current += 1;
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
        return;
      }
      const ws = new WebSocket(buildSyncUrl(baseUrl, roomId, token));
      socket = ws;
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        setLastError(null);
      };
      ws.onmessage = (ev: MessageEvent) => handleMessage(ws, String(ev.data));
      // El cierre posterior se encarga de reconectar.
      ws.onerror = () => {};
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
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
    (type: CommandType, positionMs: number): string | null => {
      if (role !== 'host') return null;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return null;
      const cmd = buildCommand(type, roomId, positionMs);
      ws.send(JSON.stringify(cmd));
      return cmd.event_id;
    },
    [role, roomId],
  );

  return { connected, state, hostOnline, lastError, correction, sendCommand };
}
