import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAX_BARS, ReactionBars } from './ReactionBars';

describe('ReactionBars', () => {
  it('una barra por emoji, con el valor en la punta y aria-label', () => {
    render(
      <ReactionBars
        data={[
          { emoji: '👏', count: 10 },
          { emoji: '😂', count: 4 },
        ]}
      />,
    );
    const svg = screen.getByRole('img', { name: 'Reacciones por emoji: 👏 10, 😂 4.' });
    const bars = svg.querySelectorAll('[data-testid="reaction-bar"]');
    expect(bars).toHaveLength(2);
    // La barra mayor ocupa más ancho que la menor.
    const width = (el: Element) => Number(el.getAttribute('data-width'));
    expect(width(bars[0])).toBeGreaterThan(width(bars[1]));
    expect(within(svg).getByText('10')).toBeInTheDocument();
    expect(within(svg).getByText('👏')).toBeInTheDocument();
  });

  it('agrupa lo que pase de MAX_BARS en "Otros"', () => {
    const data = Array.from({ length: MAX_BARS + 2 }, (_, i) => ({ emoji: `e${i}`, count: 20 - i }));
    render(<ReactionBars data={data} />);
    const svg = screen.getByRole('img');
    expect(svg.querySelectorAll('[data-testid="reaction-bar"]')).toHaveLength(MAX_BARS);
    const others = 20 - (MAX_BARS - 1) + (20 - MAX_BARS) + (20 - MAX_BARS - 1);
    expect(within(svg).getByText('Otros')).toBeInTheDocument();
    expect(within(svg).getByText(String(others))).toBeInTheDocument();
    // La tabla conserva el detalle completo.
    const table = screen.getByRole('table', { name: 'Reacciones por emoji' });
    expect(within(table).getAllByRole('row')).toHaveLength(data.length + 1);
  });

  it('sin reacciones muestra el estado vacío', () => {
    render(<ReactionBars data={[]} />);
    expect(screen.getByText('Nadie ha reaccionado todavía')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('cada barra tiene un tooltip nativo con emoji y conteo', () => {
    render(<ReactionBars data={[{ emoji: '🔥', count: 1 }]} />);
    expect(screen.getByRole('img').querySelector('title')?.textContent).toBe('🔥: 1 reacción');
  });
});
