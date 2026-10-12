import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { TimelinePoint } from '../../lib/analytics';
import { useElementWidth } from '../../hooks/useElementWidth';
import { formatClockTime, niceTicks } from '../../lib/chartScale';
import { ChartCard, CHART_COLORS, DataTable } from './ChartCard';

/** Ancho de respaldo si no se puede medir el contenedor. */
const FALLBACK_W = 640;
const H = 220;
const PAD = { top: 12, right: 28, bottom: 24, left: 32 };
const PLOT_H = H - PAD.top - PAD.bottom;

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Espectadores conectados en el tiempo (área + línea de 2 px, una sola serie, sin
 * leyenda). Crosshair con lectura de todos los valores del intervalo por puntero y
 * teclado (flechas/Inicio/Fin); los mismos datos están en la tabla alternativa.
 */
export function ViewersChart({ points }: { points: TimelinePoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  // El viewBox usa el ancho real: el texto del SVG no se escala con la pantalla.
  const [measure, W] = useElementWidth<HTMLDivElement>(FALLBACK_W);
  const PLOT_W = W - PAD.left - PAD.right;

  const table = (
    <DataTable
      caption="Espectadores por intervalo"
      columns={['Hora', 'Espectadores', 'Mensajes', 'Reacciones']}
      rows={points.map((p) => [formatClockTime(p.t), p.connected_users, p.messages, p.reactions])}
    />
  );

  const card = (children: ReactNode, withTable: boolean) => (
    <ChartCard
      title="Espectadores en el tiempo"
      description="Personas conectadas al final de cada intervalo."
      table={withTable ? table : undefined}
    >
      {children}
    </ChartCard>
  );

  if (points.length === 0) {
    return card(<p className="py-10 text-center text-sm text-tint-muted">Sin datos de asistencia todavía</p>, false);
  }

  const ticks = niceTicks(Math.max(...points.map((p) => p.connected_users)));
  const yMax = ticks[ticks.length - 1];
  const last = points.length - 1;
  const x = (i: number) => PAD.left + (last === 0 ? PLOT_W / 2 : (i / last) * PLOT_W);
  const y = (v: number) => PAD.top + PLOT_H - (v / yMax) * PLOT_H;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.connected_users)}`).join(' ');
  const area = `${line} L${x(last)},${y(0)} L${x(0)},${y(0)} Z`;
  const peak = Math.max(...points.map((p) => p.connected_users));
  const first = formatClockTime(points[0].t);
  const end = formatClockTime(points[last].t);
  const label = `Espectadores conectados de ${first} a ${end}: máximo ${peak}, último ${points[last].connected_users}.`;
  const xLabels = Array.from(new Set([0, Math.floor(last / 2), last]));

  const indexAt = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    const svgX = ratio * W;
    if (last === 0) return 0;
    return Math.min(last, Math.max(0, Math.round(((svgX - PAD.left) / PLOT_W) * last)));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? last;
    const next: Record<string, number> = {
      ArrowLeft: Math.max(0, current - 1),
      ArrowRight: Math.min(last, current + 1),
      Home: 0,
      End: last,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    setActive(next[e.key]);
  };

  const shown = active === null ? null : points[active];

  return card(
    <div ref={measure} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block h-auto w-full overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? CHART_COLORS.axis : CHART_COLORS.grid} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-tint-muted text-[11px] tabular-nums">
              {t}
            </text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 6}
            textAnchor={i === 0 && last > 0 ? 'start' : i === last && last > 0 ? 'end' : 'middle'}
            className="fill-tint-muted text-[11px] tabular-nums"
          >
            {formatClockTime(points[i].t)}
          </text>
        ))}
        {last > 0 && (
          <>
            <path data-testid="viewers-area" d={area} fill={CHART_COLORS.series} fillOpacity={0.1} />
            <path data-testid="viewers-line" d={line} fill="none" stroke={CHART_COLORS.series} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {active !== null && (
          <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={y(0)} stroke={CHART_COLORS.axis} strokeWidth={1} />
        )}
        <circle
          data-testid="viewers-end"
          cx={x(active ?? last)}
          cy={y(points[active ?? last].connected_users)}
          r={4}
          fill={CHART_COLORS.series}
          stroke={CHART_COLORS.surface}
          strokeWidth={2}
        />
        <text
          data-testid="viewers-end-label"
          x={x(last) + 8}
          y={y(points[last].connected_users)}
          dy="0.32em"
          className="fill-tint-text text-[12px] font-semibold tabular-nums"
        >
          {points[last].connected_users}
        </text>
      </svg>
      <div
        data-testid="viewers-overlay"
        role="slider"
        tabIndex={0}
        aria-label="Explorar espectadores por intervalo"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={active ?? last}
        aria-valuetext={`${formatClockTime(points[active ?? last].t)}: ${plural(points[active ?? last].connected_users, 'espectador', 'espectadores')}`}
        className="absolute inset-0 cursor-crosshair rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent"
        onPointerMove={(e) => setActive(indexAt(e))}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((v) => v ?? last)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      />
      {shown && active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 rounded-lg border border-white/10 bg-tint-bg/95 px-3 py-2 text-[12px] shadow-lg"
          style={{
            left: `${(x(active) / W) * 100}%`,
            transform: `translateX(${active > last / 2 ? 'calc(-100% - 8px)' : '8px'})`,
          }}
        >
          <p className="text-tint-muted">{formatClockTime(shown.t)}</p>
          <p className="font-semibold text-white">{plural(shown.connected_users, 'espectador', 'espectadores')}</p>
          <p className="text-tint-muted">
            {plural(shown.messages, 'mensaje', 'mensajes')} · {plural(shown.reactions, 'reacción', 'reacciones')}
          </p>
        </div>
      )}
    </div>,
    true,
  );
}
