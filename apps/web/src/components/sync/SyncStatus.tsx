import { useEffect, useState } from 'react';
import type { ReconnectInfo } from '../../hooks/useSyncSocket';
import { syncQuality, type SyncQuality } from '../../lib/syncQuality';

const QUALITY: Record<SyncQuality, { label: string; dot: string }> = {
  good: { label: 'Sincronía buena', dot: 'bg-tint-success' },
  fair: { label: 'Sincronía regular', dot: 'bg-yellow-400' },
  poor: { label: 'Sincronía inestable', dot: 'bg-red-500' },
  unknown: { label: 'Midiendo sincronía…', dot: 'bg-white/40' },
};

function signed(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded > 0) return `+${rounded}`;
  if (rounded < 0) return `−${Math.abs(rounded)}`;
  return '0';
}

/**
 * Semáforo de calidad de sincronía (verde/amarillo/rojo) con el RTT y el desfase que
 * mide sync-core. El color nunca es la única señal: siempre va con texto.
 */
export function SyncQualityIndicator({ rttMs, driftMs }: { rttMs: number | null; driftMs: number | null }) {
  const quality = syncQuality(rttMs, driftMs);
  const { label, dot } = QUALITY[quality];
  const details = rttMs === null ? '' : `RTT ${Math.round(rttMs)} ms · desfase ${signed(driftMs ?? 0)} ms`;
  return (
    <span
      data-testid="sync-quality"
      data-quality={quality}
      title={details || undefined}
      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px]"
    >
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="text-white">{label}</span>
      {details && <span className="sr-only tabular-nums text-tint-muted sm:not-sr-only">{details}</span>}
    </span>
  );
}

function secondsUntil(t: number): number {
  return Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

/** Estado de conexión explícito: "Reconectando… intento 3 · 4 s" con cuenta regresiva. */
export function ReconnectStatus({ connected, reconnect }: { connected: boolean; reconnect: ReconnectInfo | null }) {
  const nextRetryAt = reconnect?.nextRetryAt ?? null;
  const [seconds, setSeconds] = useState(() => (nextRetryAt === null ? 0 : secondsUntil(nextRetryAt)));

  useEffect(() => {
    if (nextRetryAt === null) return;
    setSeconds(secondsUntil(nextRetryAt));
    const id = setInterval(() => setSeconds(secondsUntil(nextRetryAt)), 250);
    return () => clearInterval(id);
  }, [nextRetryAt]);

  if (connected) {
    return (
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-tint-success" />
        <span className="text-[13px] text-white">Sincronizado</span>
      </span>
    );
  }

  if (!reconnect) {
    return (
      <span className="inline-flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-3 w-3 rounded-full border-2 border-tint-accent border-t-transparent motion-safe:animate-spin"
        />
        <span className="text-[13px] text-white">Conectando…</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-3 w-3 rounded-full border-2 border-tint-accent border-t-transparent motion-safe:animate-spin"
      />
      {/* La cuenta regresiva cambia cada segundo: se oculta a lectores de pantalla. */}
      <span aria-hidden="true" data-testid="reconnect-countdown" className="tabular-nums text-[13px] text-white">
        Reconectando… intento {reconnect.attempt}
        {seconds > 0 ? ` · ${seconds} s` : ''}
      </span>
      <span className="sr-only">Reconectando, intento {reconnect.attempt}</span>
    </span>
  );
}
