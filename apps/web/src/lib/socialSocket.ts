/** Contrato del Canal Social (/ws/social) — solo chat en este alcance. */

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

export type SocialIncoming = ChatMessage | HistoryEnvelope | PresenceNotice | SocialError;

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
  if (type === 'chat_message' || type === 'history' || type === 'error' || type === 'notice') {
    return data as SocialIncoming;
  }
  return null;
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
