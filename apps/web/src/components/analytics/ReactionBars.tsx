import { useElementWidth } from '../../hooks/useElementWidth';
import type { EmojiCount } from '../../lib/analytics';
import { ChartCard, CHART_COLORS, DataTable } from './ChartCard';

/** Barras visibles; el resto se agrupa en "Otros" (la tabla conserva el detalle). */
export const MAX_BARS = 8;

/** Ancho de respaldo si no se puede medir el contenedor. */
const FALLBACK_W = 640;
const ROW = 32;
const BAR = 20;
const LABEL_W = 56;
const VALUE_W = 48;
const RADIUS = 4;

/** Rectángulo con el extremo de datos (derecho) redondeado y la base recta. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}

function fold(data: EmojiCount[]): EmojiCount[] {
  if (data.length <= MAX_BARS) return data;
  const shown = data.slice(0, MAX_BARS - 1);
  const rest = data.slice(MAX_BARS - 1).reduce((sum, d) => sum + d.count, 0);
  return [...shown, { emoji: 'Otros', count: rest }];
}

/** Reacciones por emoji: barras horizontales de una sola serie, ordenadas de mayor a menor. */
export function ReactionBars({ data }: { data: EmojiCount[] }) {
  // El viewBox usa el ancho real: el texto del SVG no se escala con la pantalla.
  const [measure, W] = useElementWidth<HTMLDivElement>(FALLBACK_W);
  const table = (
    <DataTable caption="Reacciones por emoji" columns={['Emoji', 'Reacciones']} rows={data.map((d) => [d.emoji, d.count])} />
  );

  if (data.length === 0) {
    return (
      <ChartCard title="Reacciones por emoji">
        <p className="py-10 text-center text-sm text-tint-muted">Nadie ha reaccionado todavía</p>
      </ChartCard>
    );
  }

  const rows = fold(data);
  const max = Math.max(...rows.map((d) => d.count));
  const plotW = W - LABEL_W - VALUE_W;
  const height = rows.length * ROW;
  const label = `Reacciones por emoji: ${data.map((d) => `${d.emoji} ${d.count}`).join(', ')}.`;

  return (
    <ChartCard title="Reacciones por emoji" description="Total de la sesión." table={table}>
      <div ref={measure}>
        <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="block h-auto w-full">
          <line x1={LABEL_W} x2={LABEL_W} y1={0} y2={height} stroke={CHART_COLORS.axis} strokeWidth={1} />
          {rows.map((d, i) => {
            const w = max > 0 ? Math.max(2, (d.count / max) * plotW) : 2;
            const y = i * ROW + (ROW - BAR) / 2;
            return (
              <g key={d.emoji} className="group">
                <title>{`${d.emoji}: ${d.count} ${d.count === 1 ? 'reacción' : 'reacciones'}`}</title>
                <text
                  x={LABEL_W - 10}
                  y={i * ROW + ROW / 2}
                  dy="0.35em"
                  textAnchor="end"
                  className={d.emoji === 'Otros' ? 'fill-tint-muted text-[12px]' : 'text-[16px]'}
                >
                  {d.emoji}
                </text>
                <path
                  data-testid="reaction-bar"
                  data-width={w}
                  d={barPath(LABEL_W, y, w, BAR)}
                  fill={CHART_COLORS.series}
                  className="transition-opacity group-hover:opacity-80"
                />
                <text
                  x={LABEL_W + w + 8}
                  y={i * ROW + ROW / 2}
                  dy="0.35em"
                  className="fill-tint-text text-[12px] font-semibold tabular-nums"
                >
                  {d.count}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </ChartCard>
  );
}
