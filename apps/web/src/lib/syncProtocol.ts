/**
 * Protocolo del "Canal Sync" (WebSocket /ws/sync de sync-core).
 *
 * Todos los mensajes son objetos JSON planos. El servidor (Go) es la fuente de verdad:
 * este módulo solo tipa los mensajes, construye los comandos del cliente y estima la
 * posición maestra a partir del último snapshot recibido.
 */

export type PlaybackStatus = 'playing' | 'paused';
export type CommandType = 'PLAY' | 'PAUSE' | 'SEEK';
export type CorrectionStrategy = 'rate' | 'seek';
export type ServerErrorCode = 'FORBIDDEN' | 'INVALID' | 'RATE_LIMITED' | 'INTERNAL';

/** Estado maestro de reproducción tal como lo emite sync-core. */
export interface SyncState {
  status: PlaybackStatus;
  position_ms: number;
  /** Unix ms (reloj del servidor) del ancla `position_ms`. */
  updated_at_ms: number;
  rate: number;
  version: number;
  /** Unix ms (reloj del servidor) en que se envió el mensaje. */
  server_time_ms: number;
}

/** Snapshot local: estado maestro + instante local (performance.now) de recepción. */
export interface SyncSnapshot extends SyncState {
  received_at_perf: number;
}

export interface StateMessage extends SyncState {
  type: 'STATE';
  online?: boolean;
}

export interface BroadcastMessage extends SyncState {
  type: CommandType;
  event_id?: string;
  room_id?: string;
  occurred_at?: string;
  received_at?: string;
}

export interface HeartbeatMessage {
  type: 'HEARTBEAT';
  server_time_ms: number;
}

export interface CorrectionMessage {
  type: 'SYNC_CORRECTION';
  target_ms: number;
  strategy: CorrectionStrategy;
  drift_ms: number;
  version: number;
}

export interface HostStatusMessage {
  type: 'HOST_STATUS';
  online: boolean;
}

export interface AckMessage {
  type: 'ACK';
  ref_event_id: string;
  version: number;
  duplicate?: boolean;
}

export interface ErrorMessage {
  type: 'ERROR';
  ref_event_id?: string;
  code: ServerErrorCode;
}

export type ServerMessage =
  | StateMessage
  | BroadcastMessage
  | HeartbeatMessage
  | CorrectionMessage
  | HostStatusMessage
  | AckMessage
  | ErrorMessage;

export interface ClientCommand {
  event_id: string;
  type: CommandType;
  room_id: string;
  position_ms: number;
  occurred_at: string;
}

export interface SyncCheckMessage {
  event_id: string;
  type: 'SYNC_CHECK';
  room_id: string;
  position_ms: number;
  occurred_at: string;
  echo_server_ts: number;
}

const SERVER_TYPES = new Set<string>([
  'STATE',
  'PLAY',
  'PAUSE',
  'SEEK',
  'HEARTBEAT',
  'SYNC_CORRECTION',
  'HOST_STATUS',
  'ACK',
  'ERROR',
]);

/** Parsea un frame del servidor; devuelve null si no es un mensaje conocido. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== 'string' || !SERVER_TYPES.has(type)) return null;
  return data as ServerMessage;
}

/** Estima el reloj del servidor ahora, a partir del snapshot y el reloj monotónico local. */
export function estimateServerNow(snapshot: SyncSnapshot, perfNowMs: number): number {
  return snapshot.server_time_ms + (perfNowMs - snapshot.received_at_perf);
}

/** Posición maestra esperada (ms) para el instante de servidor `serverNowMs`. */
export function expectedPosition(state: SyncState, serverNowMs: number): number {
  if (state.status !== 'playing') return state.position_ms;
  const elapsed = Math.max(0, serverNowMs - state.updated_at_ms);
  return state.position_ms + elapsed * state.rate;
}

export function buildCommand(
  type: CommandType,
  roomId: string,
  positionMs: number,
  now: Date = new Date(),
): ClientCommand {
  return {
    event_id: crypto.randomUUID(),
    type,
    room_id: roomId,
    position_ms: Math.round(positionMs),
    occurred_at: now.toISOString(),
  };
}

export function buildSyncCheck(
  roomId: string,
  positionMs: number,
  echoServerTs: number,
  now: Date = new Date(),
): SyncCheckMessage {
  return {
    event_id: crypto.randomUUID(),
    type: 'SYNC_CHECK',
    room_id: roomId,
    position_ms: Math.round(positionMs),
    occurred_at: now.toISOString(),
    echo_server_ts: echoServerTs,
  };
}

export function buildSyncUrl(baseUrl: string, roomId: string, token: string): string {
  return `${baseUrl}?room_id=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;

/** Backoff exponencial de reconexión: 500 ms, 1 s, 2 s, ... hasta 10 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
}
