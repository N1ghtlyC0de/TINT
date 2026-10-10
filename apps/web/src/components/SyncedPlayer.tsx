import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SyncSocketApi } from '../hooks/useSyncSocket';
import { applyCorrection, shouldRestoreRate } from '../lib/drift';
import { estimateServerNow, expectedPosition } from '../lib/syncProtocol';
import { Button } from './ui/Button';

export interface SyncedPlayerProps {
  /** URL del vídeo; sin ella se muestra un aviso. */
  src?: string;
  /** Host/cohost: puede emitir comandos. Participantes: solo lectura. */
  canControl: boolean;
  sync: SyncSocketApi;
  videoRef: RefObject<HTMLVideoElement>;
  /** Reloj monotónico local (inyectable para pruebas). */
  now?: () => number;
}

const RATE_CHECK_INTERVAL_MS = 200;

const ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN: 'No tienes permiso para controlar la reproducción.',
  RATE_LIMITED: 'Demasiados comandos seguidos; espera un momento.',
  INVALID: 'Comando inválido para el estado actual de la sala.',
  INTERNAL: 'Error del servidor de sincronía.',
  TICKET: 'No se pudo obtener el ticket de sincronía; reintentando…',
  NO_TOKEN: 'Sin sesión para sincronizar. Vuelve a abrir la invitación.',
};

const defaultNow = () => performance.now();

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function durationOf(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
}

/**
 * Reproductor sincronizado con el Canal Sync. No decide nada por sí mismo: aplica el
 * estado maestro y las correcciones de sync-core, y el host solo emite comandos que
 * el servidor valida y difunde.
 */
export function SyncedPlayer({ src, canControl, sync, videoRef, now = defaultNow }: SyncedPlayerProps) {
  const { state, correction, connected, hostOnline, lastError, sendCommand } = sync;
  const [needsGesture, setNeedsGesture] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);

  const nowRef = useRef(now);
  const stateRef = useRef(state);
  const cancelRateRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    nowRef.current = now;
    stateRef.current = state;
  });

  const cancelRateCorrection = useCallback(() => {
    cancelRateRef.current?.();
    cancelRateRef.current = null;
  }, []);

  useEffect(() => cancelRateCorrection, [cancelRateCorrection]);

  const tryPlay = useCallback((video: HTMLVideoElement) => {
    const result = video.play() as Promise<void> | undefined;
    // play() puede rechazarse por la política de autoplay: pedimos un gesto.
    if (result && typeof result.then === 'function') {
      result.then(
        () => setNeedsGesture(false),
        () => setNeedsGesture(true),
      );
    }
  }, []);

  // Aplica cada snapshot/broadcast aceptado por el hook.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !state) return;
    cancelRateCorrection();
    const expected = expectedPosition(state, estimateServerNow(state, nowRef.current()));
    video.playbackRate = state.rate;
    video.currentTime = expected / 1000;
    if (state.status === 'playing') {
      tryPlay(video);
    } else {
      video.pause();
    }
  }, [state, videoRef, cancelRateCorrection, tryPlay]);

  // Aplica las correcciones de drift decididas por el servidor.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !correction) return;
    cancelRateCorrection();
    const action = applyCorrection(video, correction);
    if (action.kind !== 'rate' || action.playbackRate === 1) return;

    const startedAt = nowRef.current();
    const check = () => {
      const snap = stateRef.current;
      const t = nowRef.current();
      const expected = snap ? expectedPosition(snap, estimateServerNow(snap, t)) : null;
      if (shouldRestoreRate(video.currentTime * 1000, expected, t - startedAt)) {
        video.playbackRate = snap?.rate ?? 1;
        cancelRateCorrection();
      }
    };
    const interval = setInterval(check, RATE_CHECK_INTERVAL_MS);
    video.addEventListener('timeupdate', check);
    cancelRateRef.current = () => {
      clearInterval(interval);
      video.removeEventListener('timeupdate', check);
    };
  }, [correction, videoRef, cancelRateCorrection]);

  const syncProgress = (video: HTMLVideoElement) => {
    setCurrentMs(Math.round(video.currentTime * 1000));
    setDurationMs(durationOf(video));
  };

  const localPositionMs = () => {
    const video = videoRef.current;
    return video ? Math.round(video.currentTime * 1000) : currentMs;
  };

  const commitSeek = () => {
    if (seekDraft === null) return;
    sendCommand('SEEK', seekDraft);
    setSeekDraft(null);
  };

  const joinPlayback = () => {
    const video = videoRef.current;
    if (video) tryPlay(video);
  };

  const controlsDisabled = !canControl || !connected;
  const percent = durationMs > 0 ? Math.round((currentMs / durationMs) * 100) : 0;
  const errorMessage = lastError ? (ERROR_MESSAGES[lastError] ?? `Error de sincronía (${lastError}).`) : '';

  return (
    <div>
      <div className="relative aspect-video bg-black">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            aria-label="Vídeo de la sala"
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-contain"
            onTimeUpdate={(e) => syncProgress(e.currentTarget)}
            onLoadedMetadata={(e) => syncProgress(e.currentTarget)}
            onDurationChange={(e) => syncProgress(e.currentTarget)}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <p className="text-[13px] text-tint-muted">Sin video configurado</p>
          </div>
        )}

        {hostOnline === false && (
          <span
            aria-live="polite"
            className="absolute left-3 top-3 rounded-full border border-white/15 bg-black/70 px-3 py-1 text-[12px] text-white"
          >
            Host desconectado
          </span>
        )}

        {needsGesture && (
          <div className="absolute inset-0 grid place-items-center bg-black/60">
            <Button onClick={joinPlayback} aria-label="Unirse a la reproducción">
              Unirse a la reproducción
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-white/10 px-4 py-3">
        <Button
          variant="primary"
          className="px-4 py-2"
          aria-label="Reproducir"
          disabled={controlsDisabled}
          onClick={() => sendCommand('PLAY', localPositionMs())}
        >
          <span aria-hidden="true">▶</span>
        </Button>
        <Button
          variant="ghost"
          className="px-4 py-2"
          aria-label="Pausar"
          disabled={controlsDisabled}
          onClick={() => sendCommand('PAUSE', localPositionMs())}
        >
          <span aria-hidden="true">❚❚</span>
        </Button>

        <div className="min-w-[160px] flex-1">
          {canControl ? (
            <input
              type="range"
              aria-label="Buscar posición"
              min={0}
              max={durationMs}
              step={100}
              value={seekDraft ?? currentMs}
              disabled={!connected}
              onChange={(e) => setSeekDraft(Number(e.target.value))}
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              onTouchEnd={commitSeek}
              className="w-full accent-tint-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent"
            />
          ) : (
            <div
              className="h-1 overflow-hidden rounded-full bg-white/15"
              role="progressbar"
              aria-label="Progreso"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full bg-tint-accent" style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>

        <span className="tabular-nums text-[13px] text-tint-muted">
          {formatTime(currentMs)} / {formatTime(durationMs)}
        </span>
      </div>

      {errorMessage && (
        <p role="alert" className="px-4 pb-3 text-[13px] text-red-300">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
