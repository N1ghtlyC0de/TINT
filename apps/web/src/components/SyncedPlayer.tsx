import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { SyncSocketApi } from '../hooks/useSyncSocket';
import { PLAYER_SHORTCUTS, SHORTCUT_SEEK_MS, usePlayerShortcuts } from '../hooks/usePlayerShortcuts';
import { useTransientFlag } from '../hooks/useTransientFlag';
import { applyCorrection, shouldRestoreRate } from '../lib/drift';
import { readNetworkHints, resolveQuality, type PlaybackQuality } from '../lib/quality';
import { estimateServerNow, expectedPosition, RATE_OPTIONS, stepRate, type SyncSnapshot } from '../lib/syncProtocol';
import { formatRate, formatTime } from '../lib/time';
import { SeekBar } from './player/SeekBar';
import { Button } from './ui/Button';

export interface SyncedPlayerProps {
  /** URL del vídeo; sin ella se muestra `emptyMessage`. */
  src?: string;
  /** Versiones del vídeo (`playback.qualities`); sin ellas se usa `src`. */
  qualities?: PlaybackQuality[];
  /** Si este cliente puede emitir comandos (de `sync.canControl`). */
  canControl: boolean;
  /** Participante con control delegado por ausencia del host (F7). */
  delegated?: boolean;
  sync: SyncSocketApi;
  videoRef: RefObject<HTMLVideoElement>;
  /** Texto cuando no hay `src`. */
  emptyMessage?: string;
  /** Reloj monotónico local (inyectable para pruebas). */
  now?: () => number;
}

const RATE_CHECK_INTERVAL_MS = 200;
/** Duración del fundido al corregir con seek. */
const FADE_MS = 180;
/** Un salto mayor a esto al aplicar estado se suaviza con fundido. */
const FADE_JUMP_MS = 2_000;
/** Marcadores de saltos del host que se conservan. */
const MAX_SEEK_MARKS = 5;

const ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN: 'No tienes permiso para controlar la reproducción.',
  RATE_LIMITED: 'Demasiados comandos seguidos; espera un momento.',
  INVALID: 'Comando inválido para el estado actual de la sala.',
  INTERNAL: 'Error del servidor de sincronía.',
  TICKET: 'No se pudo obtener el ticket de sincronía; reintentando…',
  NO_TOKEN: 'Sin sesión para sincronizar. Vuelve a abrir la invitación.',
};

const defaultNow = () => performance.now();

function durationOf(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
}

function bufferedOf(video: HTMLVideoElement): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const b = video.buffered;
  for (let i = 0; i < (b?.length ?? 0); i++) {
    ranges.push([Math.round(b.start(i) * 1000), Math.round(b.end(i) * 1000)]);
  }
  return ranges;
}

/**
 * Reproductor sincronizado con el Canal Sync. No decide nada por sí mismo: aplica el
 * estado maestro y las correcciones de sync-core, y quien tiene el control solo emite
 * comandos que el servidor valida y difunde.
 */
export function SyncedPlayer({
  src,
  qualities,
  canControl,
  delegated = false,
  sync,
  videoRef,
  emptyMessage = 'Sin video configurado',
  now = defaultNow,
}: SyncedPlayerProps) {
  const { state, correction, connected, hostOnline, lastError, lastBroadcast, sendCommand, volume, quality } = sync;
  const [needsGesture, setNeedsGesture] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [buffered, setBuffered] = useState<Array<[number, number]>>([]);
  const [marks, setMarks] = useState<number[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [fading, fade] = useTransientFlag(FADE_MS);
  /** Silencio local del participante: no cambia el volumen maestro de la sala. */
  const [localMuted, setLocalMuted] = useState(false);
  // Pistas de red/pantalla al montar: no se cambia de calidad por redimensionar la ventana.
  const [networkHints] = useState(readNetworkHints);
  const helpId = useId();
  const rateId = useId();

  const nowRef = useRef(now);
  const stateRef = useRef(state);
  const lastPosRef = useRef(0);
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

  const applyMaster = useCallback(
    (video: HTMLVideoElement, snap: SyncSnapshot) => {
      cancelRateCorrection();
      const expected = expectedPosition(snap, estimateServerNow(snap, nowRef.current()));
      if (Math.abs(video.currentTime * 1000 - expected) > FADE_JUMP_MS) fade();
      video.playbackRate = snap.rate;
      video.currentTime = expected / 1000;
      if (snap.status === 'playing') {
        tryPlay(video);
      } else {
        video.pause();
        // Sala en pausa: no hay nada a lo que unirse (y no debe poder arrancarla).
        setNeedsGesture(false);
      }
    },
    [cancelRateCorrection, fade, tryPlay],
  );

  // `auto` → cada cliente elige; si la calidad pedida no existe, cae al original. Al cambiar
  // el `src`, onLoadedMetadata re-aplica el estado maestro (posición y play/pausa).
  const chosenQuality = src ? resolveQuality(quality, qualities ?? [], networkHints) : null;
  const videoSrc = src ? (chosenQuality?.url ?? src) : undefined;

  // Volumen maestro para todos; el participante puede silenciarse solo a sí mismo.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = !canControl && localMuted;
  }, [volume, localMuted, canControl, videoSrc, videoRef]);

  // Aplica cada snapshot/broadcast aceptado por el hook.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !state) return;
    applyMaster(video, state);
  }, [state, videoRef, applyMaster]);

  // Aplica las correcciones de drift decididas por el servidor.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !correction) return;
    cancelRateCorrection();
    const action = applyCorrection(video, correction);
    if (action.kind === 'seek') {
      fade();
      return;
    }
    if (action.playbackRate === 1) return;

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
  }, [correction, videoRef, cancelRateCorrection, fade]);

  // Marcadores de los saltos del host (no los propios); se reinician con otro vídeo.
  useEffect(() => {
    if (!lastBroadcast || lastBroadcast.own) return;
    if (lastBroadcast.type === 'LOAD') setMarks([]);
    if (lastBroadcast.type === 'SEEK') {
      setMarks((m) => [...m, lastBroadcast.position_ms].slice(-MAX_SEEK_MARKS));
    }
  }, [lastBroadcast]);

  const syncProgress = (video: HTMLVideoElement) => {
    const ms = Math.round(video.currentTime * 1000);
    lastPosRef.current = ms;
    setCurrentMs(ms);
    setDurationMs(durationOf(video));
    setBuffered(bufferedOf(video));
  };

  // Nuevo src (otro vídeo o URL firmada refrescada): se re-aplica el estado maestro o,
  // si aún no hay, la última posición conocida.
  const onLoadedMetadata = (video: HTMLVideoElement) => {
    const snap = stateRef.current;
    if (snap) applyMaster(video, snap);
    else if (lastPosRef.current > 0) video.currentTime = lastPosRef.current / 1000;
    syncProgress(video);
  };

  const localPositionMs = () => {
    const video = videoRef.current;
    return video ? Math.round(video.currentTime * 1000) : currentMs;
  };

  const seekBy = (deltaMs: number) => {
    const max = durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY;
    sendCommand('SEEK', Math.min(max, Math.max(0, localPositionMs() + deltaMs)));
  };

  const togglePlay = () => {
    sendCommand(state?.status === 'playing' ? 'PAUSE' : 'PLAY', localPositionMs());
  };

  const currentRate = state?.rate ?? 1;
  const changeRate = (rate: number) => {
    if (rate === currentRate) return;
    sendCommand('RATE', localPositionMs(), { rate });
  };

  const controlsDisabled = !canControl || !connected;

  usePlayerShortcuts(canControl && connected, {
    onTogglePlay: togglePlay,
    onSeekBy: seekBy,
    onRateStep: (dir) => changeRate(stepRate(currentRate, dir)),
    onToggleHelp: () => setShowHelp((v) => !v),
  });

  // Re-aplica el estado maestro vigente: solo reproduce si la sala está reproduciendo
  // (si no, alinea la posición) y entra en el segundo actual, no en el del bloqueo.
  const joinPlayback = () => {
    const video = videoRef.current;
    const snap = stateRef.current;
    if (video && snap) applyMaster(video, snap);
  };

  const rateOptions: number[] = RATE_OPTIONS.includes(currentRate as (typeof RATE_OPTIONS)[number])
    ? [...RATE_OPTIONS]
    : [...RATE_OPTIONS, currentRate].sort((a, b) => a - b);
  const errorMessage = lastError ? (ERROR_MESSAGES[lastError] ?? `Error de sincronía (${lastError}).`) : '';

  return (
    <div>
      <div className="relative aspect-video bg-black">
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            aria-label="Vídeo de la sala"
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-contain"
            onTimeUpdate={(e) => syncProgress(e.currentTarget)}
            onProgress={(e) => syncProgress(e.currentTarget)}
            onLoadedMetadata={(e) => onLoadedMetadata(e.currentTarget)}
            onDurationChange={(e) => syncProgress(e.currentTarget)}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <p className="text-[13px] text-tint-muted">{emptyMessage}</p>
          </div>
        )}

        {/* Fundido breve al corregir con seek o en saltos grandes (no con reduced-motion). */}
        <div
          aria-hidden="true"
          data-testid="sync-fade"
          data-active={fading}
          className={`pointer-events-none absolute inset-0 bg-black transition-opacity duration-200 ease-out motion-reduce:transition-none ${
            fading ? 'opacity-80' : 'opacity-0'
          }`}
        />

        <div className="absolute left-3 top-3 flex flex-col items-start gap-2">
          {hostOnline === false && (
            <span
              aria-live="polite"
              className="rounded-full border border-white/15 bg-black/70 px-3 py-1 text-[12px] text-white"
            >
              Host desconectado
            </span>
          )}
          {delegated && (
            <span
              role="status"
              className="rounded-full border border-tint-accent/50 bg-black/80 px-3 py-1 text-[12px] text-white"
            >
              El host no está: tienes el control temporal
            </span>
          )}
        </div>

        {needsGesture && (
          <div className="absolute inset-0 grid place-items-center bg-black/60">
            <Button onClick={joinPlayback} aria-label="Unirse a la reproducción">
              Unirse a la reproducción
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-white/10 px-4 pb-3 pt-2">
        <SeekBar
          currentMs={currentMs}
          durationMs={durationMs}
          buffered={buffered}
          marks={marks}
          interactive={canControl}
          disabled={!connected}
          onSeek={(ms) => sendCommand('SEEK', ms)}
        />

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="quiet"
            className="px-3 py-2"
            aria-label="Retroceder 10 segundos"
            aria-keyshortcuts="ArrowLeft j"
            disabled={controlsDisabled}
            onClick={() => seekBy(-SHORTCUT_SEEK_MS)}
          >
            <span aria-hidden="true">−10</span>
          </Button>
          <Button
            variant="primary"
            className="px-4 py-2"
            aria-label="Reproducir"
            aria-keyshortcuts="Space k"
            disabled={controlsDisabled}
            onClick={() => sendCommand('PLAY', localPositionMs())}
          >
            <span aria-hidden="true">▶</span>
          </Button>
          <Button
            variant="ghost"
            className="px-4 py-2"
            aria-label="Pausar"
            aria-keyshortcuts="Space k"
            disabled={controlsDisabled}
            onClick={() => sendCommand('PAUSE', localPositionMs())}
          >
            <span aria-hidden="true">❚❚</span>
          </Button>
          <Button
            variant="quiet"
            className="px-3 py-2"
            aria-label="Avanzar 10 segundos"
            aria-keyshortcuts="ArrowRight l"
            disabled={controlsDisabled}
            onClick={() => seekBy(SHORTCUT_SEEK_MS)}
          >
            <span aria-hidden="true">+10</span>
          </Button>

          <span className="ml-1 tabular-nums text-[13px] text-tint-muted">
            {formatTime(currentMs)} / {formatTime(durationMs)}
          </span>

          <div className="ml-auto flex items-center gap-2">
            {canControl ? (
              <>
                <label htmlFor={rateId} className="sr-only">
                  Velocidad
                </label>
                <select
                  id={rateId}
                  value={String(currentRate)}
                  disabled={!connected}
                  aria-keyshortcuts="[ ]"
                  onChange={(e) => changeRate(Number(e.target.value))}
                  className="rounded-full border border-white/15 bg-tint-bg px-3 py-1.5 text-[13px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent disabled:opacity-50"
                >
                  {rateOptions.map((r) => (
                    <option key={r} value={String(r)}>
                      {formatRate(r)}×
                    </option>
                  ))}
                </select>
                <Button
                  variant="quiet"
                  className="px-3 py-1.5 text-[13px]"
                  aria-expanded={showHelp}
                  aria-controls={helpId}
                  aria-keyshortcuts="?"
                  onClick={() => setShowHelp((v) => !v)}
                >
                  Atajos de teclado
                </Button>
              </>
            ) : (
              <>
                {currentRate !== 1 && (
                  <span
                    aria-label={`Velocidad ${formatRate(currentRate)}×`}
                    className="rounded-full border border-white/15 px-2.5 py-0.5 text-[12px] tabular-nums text-white"
                  >
                    {formatRate(currentRate)}×
                  </span>
                )}
                <Button
                  variant="quiet"
                  className="px-3 py-1.5 text-[13px]"
                  aria-label="Silenciar solo para mí"
                  aria-pressed={localMuted}
                  onClick={() => setLocalMuted((m) => !m)}
                >
                  <span aria-hidden="true">{localMuted ? '🔇' : '🔊'}</span>
                </Button>
              </>
            )}
          </div>
        </div>

        {canControl && showHelp && (
          <dl
            id={helpId}
            className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[13px]"
          >
            {PLAYER_SHORTCUTS.map((s) => (
              <div key={s.keys} className="contents">
                <dt>
                  <kbd className="rounded border border-white/20 bg-white/5 px-1.5 py-0.5 font-mono text-[12px] text-white">
                    {s.keys}
                  </kbd>
                </dt>
                <dd className="text-tint-muted">{s.action}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {errorMessage && (
        <p role="alert" className="px-4 pb-3 text-[13px] text-red-300">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
