/** Contrato del Canal Social (/ws/social): chat, reacciones, puntero láser, encuestas y recap. */

export const CHAT_MAX_LENGTH = 280;
export const CHAT_HISTORY_LIMIT = 50;

export interface ChatMessage {
  event_id: string;
  type: 'chat_message';
  room_id: string;
  user_id: string;
  nick: string;
  text: string;
  occurred_at: string;
  received_at: string;
}

export interface HistoryEnvelope {
  type: 'history';
  room_id: string;
  messages: ChatMessage[];
}

export interface SocialError {
  type: 'error';
  code: string;
  event_id_ref?: string;
}

export type NoticeKind = 'joined' | 'left';

export interface PresenceNotice {
  event_id: string;
  type: 'notice';
  room_id: string;
  user_id: string;
  nick: string;
  kind: NoticeKind;
  text: string;
  occurred_at: string;
}

/** Set de reacciones: REQ-20 (risa, susto, sorpresa, aplauso, corazón) más tristeza. */
export const REACTION_EMOJIS = ['👏', '😂', '😮', '😱', '❤️', '😢'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

export interface ReactionBroadcast {
  event_id: string;
  type: 'reaction';
  room_id: string;
  user_id: string;
  nick: string;
  emoji: string;
  position_ms: number;
  occurred_at: string;
  received_at: string;
}

/** Punto del puntero láser del host (x, y normalizados 0..1 sobre el vídeo). */
export interface LaserBroadcast {
  type: 'laser';
  event_id: string;
  user_id: string;
  nick: string;
  x: number;
  y: number;
  /** true en el último punto del trazo (al soltar). */
  end: boolean;
}

/** Punto en memoria: los propios se pintan al enviarlos (`own`) y su eco se descarta. */
export interface LaserPoint extends LaserBroadcast {
  own?: boolean;
}

export type SocialIncoming =
  | ChatMessage
  | HistoryEnvelope
  | PresenceNotice
  | ReactionBroadcast
  | LaserBroadcast
  | SocialError;

export function newEventId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Coordenada normalizada con 4 decimales (frames pequeños a 30 puntos/s). */
const round4 = (value: number) => Math.round(clamp01(value) * 10_000) / 10_000;

export function buildLaserPoint(roomId: string, x: number, y: number, end = false, eventId = newEventId()): string {
  const frame: Record<string, unknown> = { type: 'laser_point', event_id: eventId, room_id: roomId, x: round4(x), y: round4(y) };
  if (end) frame.end = true;
  return JSON.stringify(frame);
}

export function buildSocialUrl(base: string, roomId: string, token: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}room_id=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
}

export function buildChatSend(roomId: string, text: string): string {
  const trimmed = text.trim();
  const eventId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return JSON.stringify({
    event_id: eventId,
    type: 'chat_send',
    room_id: roomId,
    text: trimmed,
    occurred_at: new Date().toISOString(),
  });
}

/** Devuelve el mensaje parseado o null si no es un evento social conocido. */
export function parseSocialMessage(raw: string): SocialIncoming | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (
    type === 'chat_message' ||
    type === 'history' ||
    type === 'error' ||
    type === 'notice' ||
    type === 'reaction' ||
    type === 'laser'
  ) {
    return data as SocialIncoming;
  }
  return null;
}

/** Arma un reaction_send con emoji y posición en ms (0 si se desconoce). */
export function buildReactionSend(roomId: string, emoji: string, positionMs = 0): string {
  const eventId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return JSON.stringify({
    event_id: eventId,
    type: 'reaction_send',
    room_id: roomId,
    emoji,
    position_ms: Math.max(0, Math.floor(positionMs)),
    occurred_at: new Date().toISOString(),
  });
}

/** Texto del aviso de presencia según kind y nick (fallback al text del servidor). */
export function noticeText(msg: PresenceNotice): string {
  if (msg.kind === 'left') return `${msg.nick} salió del chat`;
  return `${msg.nick} entró al chat`;
}

/**
 * Formatea un ISO-8601 a HH:MM en hora local del navegador.
 * Retorna '' si la fecha es inválida o vacía.
 */
export function formatChatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
