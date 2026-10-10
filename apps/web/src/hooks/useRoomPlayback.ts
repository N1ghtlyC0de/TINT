import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';

/** Refresca la URL firmada este tiempo antes de `expiresAt`. */
export const PLAYBACK_REFRESH_LEAD_MS = 60_000;
/** Espera mínima entre refrescos (evita bucles si el servidor da URLs casi vencidas). */
export const PLAYBACK_MIN_REFRESH_MS = 5_000;

export interface UseRoomPlaybackOptions {
  /** Credencial con la que se pide (host → Firebase, guest → tint_guest_token). */
  role?: 'host' | 'guest';
  enabled?: boolean;
  refreshLeadMs?: number;
}

export interface RoomPlayback {
  url: string | null;
  mediaId: string | null;
  expiresAt: string | null;
  loading: boolean;
  error: string | null;
}

interface PlaybackResponse {
  mediaId?: string | null;
  url?: string | null;
  expiresAt?: string | null;
}

interface PlaybackData {
  url: string | null;
  mediaId: string | null;
  expiresAt: string | null;
}

const EMPTY: PlaybackData = { url: null, mediaId: null, expiresAt: null };

/**
 * Vídeo asignado a la sala (contrato v2 §9: `GET /rooms/:id/playback`).
 *
 * `syncMediaId` es el `media_id` del estado sync (undefined antes del primer STATE,
 * '' si la sala no tiene vídeo). Se vuelve a pedir cuando cambia respecto al vídeo
 * cargado y ~1 min antes de que caduque la URL firmada (el reproductor conserva la
 * posición al cambiar el `src`).
 */
export function useRoomPlayback(
  roomId: string,
  syncMediaId: string | undefined,
  { role = 'host', enabled = true, refreshLeadMs = PLAYBACK_REFRESH_LEAD_MS }: UseRoomPlaybackOptions = {},
): RoomPlayback {
  const [data, setData] = useState<PlaybackData>(EMPTY);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const requestRef = useRef(0);
  /** media_id del último vídeo obtenido ('' = sin vídeo; undefined = nada aún). */
  const loadedRef = useRef<string | undefined>(undefined);

  const load = useCallback(() => {
    const id = ++requestRef.current;
    setLoading(true);
    apiFetch(`/rooms/${encodeURIComponent(roomId)}/playback`, { method: 'GET' }, role)
      .then((res: PlaybackResponse) => {
        if (id !== requestRef.current) return;
        const next: PlaybackData = {
          mediaId: res?.mediaId ?? null,
          url: res?.url ?? null,
          expiresAt: res?.expiresAt ?? null,
        };
        loadedRef.current = next.mediaId ?? '';
        setData(next);
        setError(null);
        setLoading(false);
      })
      .catch(() => {
        if (id !== requestRef.current) return;
        setError('No se pudo cargar el vídeo de la sala.');
        setLoading(false);
      });
  }, [roomId, role]);

  // Nueva sala / credencial: se olvida lo cargado.
  useEffect(() => {
    loadedRef.current = undefined;
    return () => {
      requestRef.current += 1;
    };
  }, [roomId, role]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    if (loadedRef.current !== undefined) {
      // Ya hay vídeo: solo se re-pide si el estado sync anuncia otro.
      if (syncMediaId === undefined || syncMediaId === loadedRef.current) return;
    }
    load();
  }, [enabled, syncMediaId, load]);

  // Refresco antes de que caduque la URL firmada.
  useEffect(() => {
    if (!enabled || !data.expiresAt) return;
    const expiresAt = Date.parse(data.expiresAt);
    if (Number.isNaN(expiresAt)) return;
    const delay = Math.max(PLAYBACK_MIN_REFRESH_MS, expiresAt - Date.now() - refreshLeadMs);
    const timer = setTimeout(load, delay);
    return () => clearTimeout(timer);
  }, [enabled, data.expiresAt, refreshLeadMs, load]);

  return { ...data, loading, error };
}
