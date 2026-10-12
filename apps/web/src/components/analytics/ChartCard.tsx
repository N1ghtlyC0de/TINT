import type { ReactNode } from 'react';
import { Card } from '../ui/Primitives';

/**
 * Colores de los gráficos de analítica sobre la superficie oscura de TINT (`tint.card`).
 * Validados con la skill dataviz (validate_palette.js, modo dark, superficie #313338):
 * - SERIES: el naranja de marca bajado a la banda de luminosidad de datos (L 0.48–0.67)
 *   y ≥ 3:1 sobre la superficie (el `tint.accent` #FF6B1A queda fuera de banda).
 * - HEAT_RAMP: rampa ordinal de un solo tono, de menos (cerca de la superficie, 2.87:1)
 *   a más (más claro), con saltos de luminosidad visibles entre pasos.
 */
export const CHART_COLORS = {
  series: '#E8601C',
  surface: '#313338',
  grid: 'rgba(255,255,255,0.08)',
  axis: 'rgba(255,255,255,0.2)',
  empty: 'rgba(255,255,255,0.04)',
  heatRamp: ['#C4581E', '#F07330', '#FF9F63', '#FFC9A6'],
} as const;

export function ChartCard({
  title,
  description,
  table,
  children,
}: {
  title: string;
  description?: string;
  /** Alternativa accesible: los mismos datos en tabla, plegada bajo el gráfico. */
  table?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-white">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-tint-muted">{description}</p>}
      </div>
      {children}
      {table && (
        <details className="group text-[13px]">
          <summary className="cursor-pointer select-none text-tint-muted transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent">
            Ver datos en tabla
          </summary>
          <div className="mt-3 max-h-72 overflow-auto">{table}</div>
        </details>
      )}
    </Card>
  );
}

export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <table className="w-full border-collapse text-left text-[13px]">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col" className="border-b border-white/10 px-2 py-1.5 font-medium text-white">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-white/5">
            {row.map((cell, j) => (
              <td key={j} className="px-2 py-1.5 tabular-nums text-tint-text">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
