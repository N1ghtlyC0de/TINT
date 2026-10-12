import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocalIdentity } from '../lib/identity';
import {
  buildChatSend,
  buildLaserPoint,
  buildPollClose,
  buildPollCreate,
  buildPollVote,
  buildRecapRequest,
  buildReactionSend,
  buildSocialUrl,
  CHAT_HISTORY_LIMIT,
  clamp01,
  isReactionEmoji,
  newEventId,
  parseSocialMessage,
  validatePollDraft,
  type ChatMessage,
  type LaserPoint,
  type PollState,
  type PollView,
  type RecapMessage,
  type PresenceNotice,
  type ReactionBroadcast,
  type ReactionEmoji,
} from '../lib/socialSocket';

/** Mensaje visible en el chat: texto o aviso de presencia. */
export type SocialChatItem = ChatMessage | PresenceNotice;

/** Tope de reacciones en memoria para el overlay (efímeras, fuera del chat). */
export const REACTION_STREAM_LIMIT = 30;
/** Puntos del láser en memoria (~2 s a 30 puntos/s; el overlay los desvanece en 1.5 s). */
export const LASER_STREAM_LIMIT = 64;

export type SocialStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Último `error{code, event_id_ref}` de social-core (FORBIDDEN, POLL_ACTIVE, POLL_CLOSED…). */
export interface SocialErrorInfo {
  code: string;
  event_id_ref?: string;
}

interface UseSocialSocketOptions {
  /** Factoría inyectable para tests (por defecto el WebSocket global). */
  createSocket?: (url: string) => WebSocket;
  baseUrl?: string;
  maxMessages?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

function resolveToken(): string {
  return (
    localStorage.getItem('tint_token') || localStorage.getItem('tint_guest_token') || ''
  );
}

const SEEN_CAP = 200;

function resolveBaseUrl(override?: string): string {
  if (override) return override;
  return import.meta.env.VITE_SOCIAL_WS_URL || 'ws://localhost:8082/ws/social';
}

/**
 * Canal Social (/ws/social) solo-chat: historial al entrar + broadcast en vivo,
 * con reconexión exponencial sin tumbar el reproductor.
 */
export function useSocialSocket(roomId: string | undefined, opts: UseSocialSocketOptions = {}) {
  const [status, setStatus] = useState<SocialStatus>('connecting');
  const [messages, setMessages] = useState<SocialChatItem[]>([]);
  const [reactions, setReactions] = useState<ReactionBroadcast[]>([]);
  const [laser, setLaser] = useState<LaserPoint[]>([]);
  const [poll, setPoll] = useState<PollView | null>(null);
  const [lastError, setLastError] = useState<SocialErrorInfo | null>(null);
  const [recap, setRecap] = useState<RecapMessage | null>(null);
  /** Último voto propio visto por poll_id: los broadcasts no traen my_vote. */
  const myVotesRef = useRef<Map<string, number>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  // Refs para no reconectar cuando el padre re-renderiza con callbacks inline.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // event_id ya vistos: traga ecos/redeliveries del servidor.
  const seenRef = useRef<Set<string>>(new Set());

  const remember = useCallback((id: string): boolean => {
    if (seenRef.current.has(id)) return true;
    seenRef.current.add(id);
    if (seenRef.current.size > SEEN_CAP) {
      const oldest = seenRef.current.values().next().value;
      if (oldest !== undefined) seenRef.current.delete(oldest);
    }
    return false;
  }, []);

  const pushMessage = useCallback(
    (msg: SocialChatItem) => {
      if (remember(msg.event_id)) return;
      const max = optsRef.current.maxMessages ?? CHAT_HISTORY_LIMIT;
      setMessages((prev) => [...prev.slice(-(max - 1)), msg]);
    },
    [remember],
  );

  const pushReaction = useCallback(
    (msg: ReactionBroadcast) => {
      if (remember(msg.event_id)) return;
      setReactions((prev) => [...prev.slice(-(REACTION_STREAM_LIMIT - 1)), msg]);
    },
    [remember],
  );

  const pushLaser = useCallback(
    (msg: LaserPoint) => {
      if (remember(msg.event_id)) return;
      setLaser((prev) => [...prev.slice(-(LASER_STREAM_LIMIT - 1)), msg]);
    },
    [remember],
  );

  const applyPoll = useCallback((msg: PollState) => {
    if (typeof msg.my_vote === 'number') myVotesRef.current.set(msg.poll_id, msg.my_vote);
    setPoll({ ...msg, my_vote: myVotesRef.current.get(msg.poll_id) ?? null });
  }, []);

  useEffect(() => {
    if (!roomId) {
      setStatus('closed');
      return;
    }
    closedRef.current = false;
    attemptRef.current = 0;

    const connect = () => {
      const {
        createSocket = (url: string) => new WebSocket(url),
        baseUrl,
        maxMessages = CHAT_HISTORY_LIMIT,
        reconnectBaseMs = 500,
        reconnectMaxMs = 8000,
      } = optsRef.current;
      const token = resolveToken();
      const url = buildSocialUrl(resolveBaseUrl(baseUrl), roomId, token);
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      const ws = createSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        setStatus('open');
      };
      ws.onmessage = (event: MessageEvent) => {
        const parsed = parseSocialMessage(String(event.data));
        if (!parsed) return;
        if (parsed.type === 'history') {
          for (const m of parsed.messages) remember(m.event_id);
          setMessages(parsed.messages.slice(-maxMessages));
        } else if (parsed.type === 'chat_message' || parsed.type === 'notice') {
          pushMessage(parsed);
        } else if (parsed.type === 'reaction') {
          pushReaction(parsed);
        } else if (parsed.type === 'laser') {
          pushLaser({ ...parsed, end: parsed.end === true });
        } else if (parsed.type === 'poll_state') {
          applyPoll(parsed);
        } else if (parsed.type === 'recap') {
          setRecap(parsed);
        } else if (parsed.type === 'error') {
          setLastError({ code: parsed.code, event_id_ref: parsed.event_id_ref });
        }
      };
      ws.onclose = () => {
        // Solo el socket vigente puede cambiar el estado/programar
        // reconexión: un cierre tardío del socket viejo (StrictMode,
        // limpieza) no debe matar al nuevo.
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (closedRef.current) {
          setStatus('closed');
          return;
        }
        const delay = Math.min(
          reconnectBaseMs * 2 ** attemptRef.current,
          reconnectMaxMs,
        );
        attemptRef.current += 1;
        setStatus('reconnecting');
        timerRef.current = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      closedRef.current = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [roomId, pushMessage, pushReaction, pushLaser, applyPoll, remember]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !roomId) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(buildChatSend(roomId, trimmed));
      return true;
    },
    [roomId],
  );

  const sendReaction = useCallback(
    (emoji: string, positionMs = 0) => {
      if (!roomId || !isReactionEmoji(emoji)) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(buildReactionSend(roomId, emoji as ReactionEmoji, positionMs));
      return true;
    },
    [roomId],
  );

  /** Envía un punto del láser (x, y en 0..1) y lo pinta al instante; su eco se descarta. */
  const sendLaser = useCallback(
    (x: number, y: number, end = false) => {
      if (!roomId) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const eventId = newEventId();
      ws.send(buildLaserPoint(roomId, x, y, end, eventId));
      const me = getLocalIdentity();
      pushLaser({
        type: 'laser',
        event_id: eventId,
        user_id: me?.sub ?? '',
        nick: me?.nick ?? '',
        x: clamp01(x),
        y: clamp01(y),
        end,
        own: true,
      });
      return true;
    },
    [roomId, pushLaser],
  );

  /** Envía un frame ya armado si el socket está abierto (y limpia el último error). */
  const sendFrame = useCallback((build: (room: string) => string) => {
    if (!roomId) return false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    setLastError(null);
    ws.send(build(roomId));
    return true;
  }, [roomId]);

  const createPoll = useCallback(
    (question: string, options: string[], durationS: number) => {
      if (validatePollDraft(question, options, durationS)) return false;
      return sendFrame((room) => buildPollCreate(room, question, options, durationS));
    },
    [sendFrame],
  );

  const votePoll = useCallback(
    (pollId: string, option: number) => {
      const ok = sendFrame((room) => buildPollVote(room, pollId, option));
      if (ok) {
        // Optimista hasta que llegue el poll_state con my_vote.
        myVotesRef.current.set(pollId, option);
        setPoll((prev) => (prev && prev.poll_id === pollId ? { ...prev, my_vote: option } : prev));
      }
      return ok;
    },
    [sendFrame],
  );

  const closePoll = useCallback(
    (pollId: string) => sendFrame((room) => buildPollClose(room, pollId)),
    [sendFrame],
  );

  const requestRecap = useCallback(() => sendFrame((room) => buildRecapRequest(room)), [sendFrame]);

  return {
    status,
    messages,
    reactions,
    laser,
    poll,
    recap,
    lastError,
    send,
    sendReaction,
    sendLaser,
    createPoll,
    votePoll,
    closePoll,
    requestRecap,
  };
}
