import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildChatSend,
  buildReactionSend,
  buildSocialUrl,
  CHAT_HISTORY_LIMIT,
  isReactionEmoji,
  parseSocialMessage,
  type ChatMessage,
  type PresenceNotice,
  type ReactionBroadcast,
  type ReactionEmoji,
} from '../lib/socialSocket';

/** Mensaje visible en el chat: texto o aviso de presencia. */
export type SocialChatItem = ChatMessage | PresenceNotice;

/** Tope de reacciones en memoria para el overlay (efímeras, fuera del chat). */
export const REACTION_STREAM_LIMIT = 30;

export type SocialStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

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
        }
        // Los errores (RATE_LIMITED, etc.) se ignoran en esta fase.
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
  }, [roomId, pushMessage, pushReaction, remember]);

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

  return { status, messages, reactions, send, sendReaction };
}
