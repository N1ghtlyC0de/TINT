import { useEffect, useRef, useState } from 'react';
import { QUALITY_LABELS } from '../lib/quality';
import { formatRate, formatTime } from '../lib/time';
import type { SyncBroadcast } from './useSyncSocket';

export const TOAST_DURATION_MS = 3_000;
export const MAX_TOASTS = 3;

export interface SyncToast {
  id: number;
  text: string;
}

export function describeBroadcast(b: SyncBroadcast): string {
  switch (b.type) {
    case 'PAUSE':
      return `El host pausó en ${formatTime(b.position_ms)}`;
    case 'PLAY':
      return `El host reanudó en ${formatTime(b.position_ms)}`;
    case 'SEEK':
      return `El host saltó a ${formatTime(b.position_ms)}`;
    case 'RATE':
      return `El host cambió la velocidad a ${formatRate(b.rate)}×`;
    case 'LOAD':
      return 'El host cargó un nuevo vídeo';
    case 'VOLUME': {
      const volume = b.volume ?? 1;
      return volume === 0 ? 'El host silenció el vídeo' : `El host ajustó el volumen al ${Math.round(volume * 100)} %`;
    }
    case 'QUALITY':
      return `El host cambió la calidad a ${QUALITY_LABELS[b.quality ?? 'auto']}`;
  }
}

/**
 * Avisos efímeros de los comandos de otros (los propios se reconocen por event_id y no
 * se muestran). Cada aviso dura ~3 s y como máximo se ven 3 a la vez.
 */
export function useSyncToasts(lastBroadcast: SyncBroadcast | null): SyncToast[] {
  const [toasts, setToasts] = useState<SyncToast[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!lastBroadcast || lastBroadcast.own) return;
    const toast = { id: lastBroadcast.seq, text: describeBroadcast(lastBroadcast) };
    setToasts((list) => [...list, toast].slice(-MAX_TOASTS));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((list) => list.filter((t) => t.id !== toast.id));
    }, TOAST_DURATION_MS);
    timers.current.add(timer);
  }, [lastBroadcast]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  return toasts;
}
