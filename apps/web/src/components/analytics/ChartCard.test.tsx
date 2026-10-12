import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChartCard, DataTable } from './ChartCard';

describe('ChartCard', () => {
  it('muestra título, descripción, contenido y la tabla en un <details> plegado', async () => {
    render(
      <ChartCard title="Espectadores" description="Por minuto" table={<p>tabla</p>}>
        <p>gráfico</p>
      </ChartCard>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Espectadores' })).toBeInTheDocument();
    expect(screen.getByText('Por minuto')).toBeInTheDocument();
    expect(screen.getByText('gráfico')).toBeInTheDocument();
    const summary = screen.getByText('Ver datos en tabla');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getByText('tabla')).toBeInTheDocument();
  });

  it('sin tabla no muestra el desplegable', () => {
    render(
      <ChartCard title="Vacío">
        <p>nada</p>
      </ChartCard>,
    );
    expect(screen.queryByText('Ver datos en tabla')).not.toBeInTheDocument();
  });
});

describe('DataTable', () => {
  it('renderiza caption, encabezados y filas', () => {
    render(
      <DataTable
        caption="Reacciones por emoji"
        columns={['Emoji', 'Reacciones']}
        rows={[
          ['👏', 3],
          ['😂', 1],
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Reacciones por emoji' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Emoji', 'Reacciones']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('👏')).toBeInTheDocument();
  });
});
