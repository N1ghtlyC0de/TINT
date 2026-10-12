import type { ReactionHeatmap as Heatmap } from '../../lib/analytics';
import { heatLevel } from '../../lib/chartScale';
import { formatTime } from '../../lib/time';
import { ChartCard, CHART_COLORS, DataTable } from './ChartCard';

/** Columnas máximas: con más buckets se agrupan varios por columna. */
export const MAX_COLUMNS = 60;

const W = 600;
const ROW_H = 28;
const GAP = 2;

function levelColor(level: number): string {
  return level === 0 ? CHART_COLORS.empty : CHART_COLORS.heatRamp[level - 1];
}

function range(startMs: number, widthMs: number) {
  return `${formatTime(startMs)}–${formatTime(startMs + widthMs)}`;
}

function plural(n: number) {
  return `${n} ${n === 1 ? 'reacción' : 'reacciones'}`;
}

/**
 * Heatmap de reacciones por posición del vídeo: columnas = buckets de `bucket_ms`
 * (agrupados si superan MAX_COLUMNS), filas = emoji. Color secuencial de un solo tono
 * (más claro = más reacciones); cada celda lleva su valor en <title> y la tabla repite
 * los buckets originales.
 */
export function ReactionHeatmap({ heatmap }: { heatmap: Heatmap }) {
  const { buckets, bucket_ms: bucketMs } = heatmap;

  if (buckets.length === 0) {
    return (
      <ChartCard title="Reacciones a lo largo del vídeo">
        <p className="py-10 text-center text-sm text-tint-muted">Sin reacciones durante el vídeo</p>
      </ChartCard>
    );
  }

  const emojis = Array.from(new Set([...heatmap.by_emoji.map((e) => e.emoji), ...buckets.map((b) => b.emoji)]));
  const rawColumns = Math.floor(Math.max(...buckets.map((b) => b.bucket_start_ms)) / bucketMs) + 1;
  const factor = Math.ceil(rawColumns / MAX_COLUMNS);
  const colMs = bucketMs * factor;
  const columns = Math.ceil(rawColumns / factor);

  const grid = emojis.map(() => new Array<number>(columns).fill(0));
  for (const b of buckets) {
    const col = Math.floor(b.bucket_start_ms / colMs);
    grid[emojis.indexOf(b.emoji)][col] += b.count;
  }
  const max = Math.max(...grid.flat());
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  let peak = { emoji: emojis[0], col: 0, count: 0 };
  grid.forEach((row, r) =>
    row.forEach((count, col) => {
      if (count > peak.count) peak = { emoji: emojis[r], col, count };
    }),
  );
  const endMs = columns * colMs;
  const label =
    `Mapa de calor de reacciones por posición del vídeo: ${plural(total)} entre 0:00 y ${formatTime(endMs)}; ` +
    `pico de ${peak.emoji} en ${formatTime(peak.col * colMs)} (${peak.count}).`;

  const cellW = W / columns;
  const height = emojis.length * ROW_H;

  const table = (
    <DataTable
      caption="Reacciones por posición del vídeo"
      columns={['Posición', 'Emoji', 'Reacciones']}
      rows={buckets.map((b) => [range(b.bucket_start_ms, bucketMs), b.emoji, b.count])}
    />
  );

  return (
    <ChartCard
      title="Reacciones a lo largo del vídeo"
      description={`Dónde reaccionó la sala, por posición del vídeo. Cada columna agrupa ${colMs / 1000} s.`}
      table={table}
    >
      <div className="flex gap-3">
        <ul className="flex shrink-0 flex-col" aria-hidden="true">
          {emojis.map((e) => (
            <li key={e} className="flex items-center text-[16px] leading-none" style={{ height: ROW_H }}>
              {e}
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1">
          <svg
            viewBox={`0 0 ${W} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={label}
            className="block w-full"
            style={{ height }}
          >
            {grid.map((row, r) =>
              row.map((count, col) => {
                const level = heatLevel(count, max);
                return (
                  <rect
                    key={`${r}-${col}`}
                    data-testid="heat-cell"
                    data-level={level}
                    x={col * cellW + GAP / 2}
                    y={r * ROW_H + GAP / 2}
                    width={Math.max(0.5, cellW - GAP)}
                    height={ROW_H - GAP}
                    rx={2}
                    fill={levelColor(level)}
                    className="transition-opacity hover:opacity-80"
                  >
                    <title>{`${emojis[r]} · ${range(col * colMs, colMs)} · ${plural(count)}`}</title>
                  </rect>
                );
              }),
            )}
          </svg>
          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-tint-muted">
            <span>0:00</span>
            <span>{formatTime(endMs / 2)}</span>
            <span>{formatTime(endMs)}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-tint-muted" aria-hidden="true">
        <span>Menos</span>
        {CHART_COLORS.heatRamp.map((c) => (
          <span key={c} className="h-3 w-5 rounded-sm" style={{ background: c }} />
        ))}
        <span>Más</span>
        <span className="ml-3 h-3 w-5 rounded-sm border border-white/10" style={{ background: CHART_COLORS.empty }} />
        <span>Sin reacciones</span>
      </div>
    </ChartCard>
  );
}
