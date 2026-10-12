import { useEffect, useId, useRef, useState } from 'react';
import { isTypingTarget } from '../../hooks/usePlayerShortcuts';
import { QUALITY_LABELS, type PlaybackQuality } from '../../lib/quality';
import { QUALITY_PREFS, RATE_OPTIONS, type QualityPref } from '../../lib/syncProtocol';
import { formatRate } from '../../lib/time';
import { Button } from '../ui/Button';

/** Espera tras el último movimiento del deslizador antes de enviar VOLUME (sync-core limita a 20 msg/s). */
export const VOLUME_SEND_DEBOUNCE_MS = 150;

export interface HostControlBarProps {
  connected: boolean;
  /** Volumen maestro 0..1. */
  volume: number;
  onVolumeChange: (volume: number) => void;
  /** Calidad maestra. */
  quality: QualityPref;
  /** Versiones disponibles del vídeo (`playback.qualities`). */
  qualities: PlaybackQuality[];
  onQualityChange: (quality: QualityPref) => void;
  rate: number;
  onRateChange: (rate: number) => void;
  laserOn?: boolean;
  onToggleLaser?: () => void;
  onOpenPoll?: () => void;
}

const SELECT_CLASS =
  'rounded-full border border-white/15 bg-tint-bg px-3 py-1.5 text-[13px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent disabled:opacity-50';

const percent = (volume: number) => Math.round(volume * 100);

/**
 * Controles maestros de quien tiene el control: volumen (con silencio), calidad, velocidad,
 * puntero láser y encuestas. Solo emite intenciones; sync-core valida y difunde.
 */
export function HostControlBar({
  connected,
  volume,
  onVolumeChange,
  quality,
  qualities,
  onQualityChange,
  rate,
  onRateChange,
  laserOn = false,
  onToggleLaser,
  onOpenPoll,
}: HostControlBarProps) {
  const volumeId = useId();
  const qualityId = useId();
  const rateId = useId();
  /** Valor del deslizador mientras se arrastra (null → se muestra el maestro). */
  const [draft, setDraft] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Último volumen audible, para recuperarlo al reactivar el sonido. */
  const lastAudibleRef = useRef(volume > 0 ? volume : 1);
  const sendRef = useRef(onVolumeChange);
  const toggleLaserRef = useRef(onToggleLaser);
  const laserAvailable = !!onToggleLaser;

  useEffect(() => {
    sendRef.current = onVolumeChange;
    toggleLaserRef.current = onToggleLaser;
  });

  // Atajo L del láser. En captura sobre window para correr antes que usePlayerShortcuts
  // (L = avanzar 10 s): con preventDefault ese atajo ignora la tecla.
  useEffect(() => {
    if (!laserAvailable) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'l' && e.key !== 'L') return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      toggleLaserRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [laserAvailable]);

  useEffect(() => {
    if (volume > 0) lastAudibleRef.current = volume;
    // Llegó un maestro nuevo: manda sobre el borrador ya enviado.
    if (timerRef.current === null) setDraft(null);
  }, [volume]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const changeVolume = (value: number) => {
    setDraft(value);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      sendRef.current(value);
    }, VOLUME_SEND_DEBOUNCE_MS);
  };

  const shown = draft ?? volume;
  const muted = volume === 0;
  const toggleMute = () => onVolumeChange(muted ? lastAudibleRef.current : 0);

  const qualityOptions: QualityPref[] = QUALITY_PREFS.filter(
    (q) => q === 'auto' || q === quality || qualities.some((v) => v.id === q),
  );
  const labelOf = (q: QualityPref) => qualities.find((v) => v.id === q)?.label ?? QUALITY_LABELS[q];

  const rateOptions: number[] = RATE_OPTIONS.includes(rate as (typeof RATE_OPTIONS)[number])
    ? [...RATE_OPTIONS]
    : [...RATE_OPTIONS, rate].sort((a, b) => a - b);

  return (
    <div role="group" aria-label="Controles del host" className="mt-2 flex flex-wrap items-center gap-2">
      <Button
        variant="quiet"
        className="px-3 py-1.5 text-[13px]"
        aria-label="Silenciar a la sala"
        aria-pressed={muted}
        disabled={!connected}
        onClick={toggleMute}
      >
        <span aria-hidden="true">{muted ? '🔇' : '🔊'}</span>
      </Button>
      <label htmlFor={volumeId} className="sr-only">
        Volumen de la sala
      </label>
      <input
        id={volumeId}
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent(shown)}
        aria-valuetext={`${percent(shown)} %`}
        disabled={!connected}
        onChange={(e) => changeVolume(Number(e.target.value) / 100)}
        className="w-24 accent-tint-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent disabled:opacity-50"
      />

      <label htmlFor={qualityId} className="sr-only">
        Calidad
      </label>
      <select
        id={qualityId}
        value={quality}
        disabled={!connected}
        onChange={(e) => {
          const next = e.target.value as QualityPref;
          if (next !== quality) onQualityChange(next);
        }}
        className={SELECT_CLASS}
      >
        {qualityOptions.map((q) => (
          <option key={q} value={q}>
            {labelOf(q)}
          </option>
        ))}
      </select>

      <label htmlFor={rateId} className="sr-only">
        Velocidad
      </label>
      <select
        id={rateId}
        value={String(rate)}
        disabled={!connected}
        aria-keyshortcuts="[ ]"
        onChange={(e) => onRateChange(Number(e.target.value))}
        className={SELECT_CLASS}
      >
        {rateOptions.map((r) => (
          <option key={r} value={String(r)}>
            {formatRate(r)}×
          </option>
        ))}
      </select>

      {onToggleLaser && (
        <Button
          variant={laserOn ? 'primary' : 'ghost'}
          className="px-3 py-1.5 text-[13px]"
          aria-label="Puntero láser"
          aria-pressed={laserOn}
          aria-keyshortcuts="L"
          title="Puntero láser (L)"
          onClick={onToggleLaser}
        >
          <span aria-hidden="true">🔴</span> Láser
        </Button>
      )}
      {onOpenPoll && (
        <Button variant="ghost" className="px-3 py-1.5 text-[13px]" aria-label="Crear encuesta" onClick={onOpenPoll}>
          <span aria-hidden="true">📊</span> Encuesta
        </Button>
      )}
    </div>
  );
}
