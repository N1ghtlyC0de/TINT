import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { errorStatus } from '../lib/errorStatus';
import { normalizeQualities, type PlaybackQuality } from '../lib/quality';

/** Refresca la URL firmada este tiempo antes de `expiresAt`. */
export const PLAYBACK_REFRESH_LEAD_MS = 60_000;
/** Espera mínima entre refrescos (evita bucles si el servidor da URLs casi vencidas). */
export const PLAYBACK_MIN_REFRESH_MS = 5_000;
/** Intervalo de re-consulta mientras media-worker procesa el vídeo. */
export const PLAYBACK_PROCESSING_POLL_MS = 5_000;
/** Máximo de re-consultas por vídeo (~10 min con el intervalo por defecto). */
export const PLAYBACK_MAX_PROCESSING_POLLS = 120;

/** Estado del procesamiento del vídeo (null: asignado por clave, sin fila de vídeo). */
export type MediaStatus = 'pending' | 'processing' | 'ready' | 'failed';

const MEDIA_STATUSES: readonly string[] = ['pending', 'processing', 'ready', 'failed'];

function toMediaStatus(value: unknown): MediaStatus | null {
  return typeof value === 'string' && MEDIA_STATUSES.includes(value) ? (value as MediaStatus) : null;
}

const isProcessing = (status: MediaStatus | null) => status === 'pending' || status === 'processing';

export interface UseRoomPlaybackOptions {
  /** Credencial con la que se pide (host → Firebase, guest → tint_guest_token). */
  role?: 'host' | 'guest';
  enabled?: boolean;
  refreshLeadMs?: number;
  processingPollMs?: number;
  maxProcessingPolls?: number;
}

export interface RoomPlayback {
  url: string | null;
  mediaId: string | null;
  expiresAt: string | null;
  status: MediaStatus | null;
  /** URL firmada de ambilight.json; solo cuando status = ready. */
  ambilightUrl: string | null;
  /** Versiones disponibles (original + transcodificaciones); [] sin vídeo. */
  qualities: PlaybackQuality[];
  loading: boolean;
  error: string | null;
  /** El invitado recibió 401/403: su invitación ya no vale (se borra `tint_guest_token`). */
  revoked: boolean;
}

interface PlaybackResponse {
  mediaId?: string | null;
  url?: string | null;
  expiresAt?: string | null;
  status?: string | null;
  ambilightUrl?: string | null;
  qualities?: unknown;
}

interface PlaybackData {
  url: string | null;
  mediaId: string | null;
  expiresAt: string | null;
  status: MediaStatus | null;
  ambilightUrl: string | null;
  qualities: PlaybackQuality[];
}

const EMPTY: PlaybackData = { url: null, mediaId: null, expiresAt: null, status: null, ambilightUrl: null, qualities: [] };

function toPlaybackData(res: PlaybackResponse | undefined): PlaybackData {
  return {
    mediaId: res?.mediaId ?? null,
    url: res?.url ?? null,
    expiresAt: res?.expiresAt ?? null,
    status: toMediaStatus(res?.status),
    ambilightUrl: res?.ambilightUrl ?? null,
    // identity-api sin `qualities` (versión previa) → solo el original.
    qualities: normalizeQualities(res?.qualities, res?.url ?? null),
  };
}

/**
 * Calidades de una re-consulta conservando la URL del original ya cargada: si cambiara,
 * el reproductor recargaría el `src` sin necesidad.
 */
function keepSourceUrl(qualities: PlaybackQuality[], url: string | null): PlaybackQuality[] {
  if (!url) return qualities;
  return qualities.map((q) => (q.id === 'source' ? { ...q, url } : q));
}

/**
 * Vídeo asignado a la sala (contrato v2 §9: `GET /rooms/:id/playback`).
 *
 * `syncMediaId` es el `media_id` del estado sync (undefined antes del primer STATE,
 * '' si la sala no tiene vídeo). Se vuelve a pedir cuando cambia respecto al vídeo
 * cargado y ~1 min antes de que caduque la URL firmada (el reproductor conserva la
 * posición al cambiar el `src`).
 *
 * Mientras el vídeo está `pending`/`processing` (media-worker) se re-consulta cada ~5 s
 * hasta `ready`/`failed` o un máximo de intentos; esas re-consultas solo actualizan
 * `status`/`ambilightUrl` para no cambiar el `src` (el original ya es reproducible).
 */
export function useRoomPlayback(
  roomId: string,
  syncMediaId: string | undefined,
  {
    role = 'host',
    enabled = true,
    refreshLeadMs = PLAYBACK_REFRESH_LEAD_MS,
    processingPollMs = PLAYBACK_PROCESSING_POLL_MS,
    maxProcessingPolls = PLAYBACK_MAX_PROCESSING_POLLS,
  }: UseRoomPlaybackOptions = {},
): RoomPlayback {
  const [data, setData] = useState<PlaybackData>(EMPTY);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);

  const requestRef = useRef(0);
  const pollRequestRef = useRef(0);
  const [pollTick, setPollTick] = useState(0);
  const pollsRef = useRef<{ mediaId: string | null; count: number }>({ mediaId: null, count: 0 });
  /** media_id del último vídeo obtenido ('' = sin vídeo; undefined = nada aún). */
  const loadedRef = useRef<string | undefined>(undefined);

  const load = useCallback(() => {
    const id = ++requestRef.current;
    pollRequestRef.current += 1; // una carga completa manda sobre cualquier re-consulta en vuelo
    setLoading(true);
    apiFetch(`/rooms/${encodeURIComponent(roomId)}/playback`, { method: 'GET' }, role)
      .then((res: PlaybackResponse) => {
        if (id !== requestRef.current) return;
        const next = toPlaybackData(res);
        loadedRef.current = next.mediaId ?? '';
        setData(next);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (id !== requestRef.current) return;
        const status = errorStatus(err);
        if (role === 'guest' && (status === 401 || status === 403)) {
          // Invitación revocada o caducada (p. ej. retirado con la pestaña cerrada):
          // sync-core rechazaría el socket para siempre, así que se deja de intentar.
          localStorage.removeItem('tint_guest_token');
          setRevoked(true);
        }
        setError('No se pudo cargar el vídeo de la sala.');
        setLoading(false);
      });
  }, [roomId, role]);

  /** Re-consulta silenciosa del estado de procesamiento. */
  const poll = useCallback(() => {
    const id = ++pollRequestRef.current;
    apiFetch(`/rooms/${encodeURIComponent(roomId)}/playback`, { method: 'GET' }, role)
      .then((res: PlaybackResponse) => {
        if (id !== pollRequestRef.current) return;
        const next = toPlaybackData(res);
        if ((next.mediaId ?? '') === loadedRef.current) {
          // La URL no cambia mientras se procesa (no se corta la reproducción), salvo si
          // el worker rechazó el vídeo: identity-api ya no lo sirve (url null).
          setData((prev) =>
            next.status === 'failed'
              ? { ...prev, status: next.status, ambilightUrl: null, url: null, expiresAt: null, qualities: [] }
              : {
                  ...prev,
                  status: next.status,
                  ambilightUrl: next.ambilightUrl,
                  qualities: keepSourceUrl(next.qualities, prev.url),
                },
          );
        } else {
          // La sala cambió de vídeo entretanto: se adopta la respuesta completa.
          loadedRef.current = next.mediaId ?? '';
          setData(next);
        }
        setPollTick((t) => t + 1);
      })
      .catch(() => {
        if (id !== pollRequestRef.current) return;
        setPollTick((t) => t + 1);
      });
  }, [roomId, role]);

  // Nueva sala / credencial: se olvida lo cargado.
  useEffect(() => {
    loadedRef.current = undefined;
    return () => {
      requestRef.current += 1;
      pollRequestRef.current += 1;
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

  // Re-consulta mientras media-worker procesa el vídeo.
  useEffect(() => {
    if (!enabled || !isProcessing(data.status)) return;
    if (pollsRef.current.mediaId !== data.mediaId) pollsRef.current = { mediaId: data.mediaId, count: 0 };
    if (pollsRef.current.count >= maxProcessingPolls) return;
    const timer = setTimeout(() => {
      pollsRef.current.count += 1;
      poll();
    }, processingPollMs);
    return () => clearTimeout(timer);
  }, [enabled, data.status, data.mediaId, pollTick, poll, processingPollMs, maxProcessingPolls]);

  return { ...data, loading, error, revoked };
}
