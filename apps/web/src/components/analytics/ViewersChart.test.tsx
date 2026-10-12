import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TimelinePoint } from '../../lib/analytics';
import { ViewersChart } from './ViewersChart';

function at(minute: number) {
  return new Date(2026, 9, 11, 20, minute).toISOString();
}

const points: TimelinePoint[] = [
  { t: at(0), connected_users: 1, messages: 0, reactions: 0 },
  { t: at(1), connected_users: 3, messages: 4, reactions: 2 },
  { t: at(2), connected_users: 2, messages: 1, reactions: 5 },
];

function overlay() {
  return screen.getByTestId('viewers-overlay');
}

describe('ViewersChart', () => {
  it('dibuja línea y área con aria-label que resume la serie', () => {
    const { container } = render(<ViewersChart points={points} />);
    const svg = screen.getByRole('img', { name: /Espectadores conectados.*20:00 a 20:02.*máximo 3/ });
    expect(svg).toBeInTheDocument();
    expect(container.querySelector('[data-testid="viewers-line"]')?.getAttribute('d')).toMatch(/^M/);
    expect(container.querySelector('[data-testid="viewers-area"]')).not.toBeNull();
    // Etiqueta directa del último valor.
    expect(within(svg).getByTestId('viewers-end-label')).toHaveTextContent('2');
  });

  it('ofrece la tabla alternativa con todos los puntos', () => {
    render(<ViewersChart points={points} />);
    const table = screen.getByRole('table', { name: 'Espectadores por intervalo' });
    expect(within(table).getAllByRole('row')).toHaveLength(points.length + 1);
    expect(within(table).getByText('20:01')).toBeInTheDocument();
  });

  it('el puntero muestra la lectura del punto más cercano', () => {
    render(<ViewersChart points={points} />);
    const el = overlay();
    el.getBoundingClientRect = () => ({ left: 0, width: 640, top: 0, height: 200, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(el, { clientX: 330 });
    const tip = screen.getByRole('status');
    expect(tip).toHaveTextContent('20:01');
    expect(tip).toHaveTextContent('3 espectadores');
    expect(tip).toHaveTextContent('4 mensajes');
    expect(tip).toHaveTextContent('2 reacciones');
    fireEvent.pointerLeave(el);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('con el teclado recorre los puntos con las flechas', () => {
    render(<ViewersChart points={points} />);
    const el = overlay();
    fireEvent.focus(el);
    expect(screen.getByRole('status')).toHaveTextContent('20:02');
    fireEvent.keyDown(el, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('20:01');
    fireEvent.keyDown(el, { key: 'Home' });
    expect(screen.getByRole('status')).toHaveTextContent('20:00');
    fireEvent.keyDown(el, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('20:00');
    fireEvent.keyDown(el, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('20:02');
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('20:02');
    fireEvent.keyDown(el, { key: 'a' });
    fireEvent.blur(el);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('con un solo punto dibuja el marcador sin línea', () => {
    const { container } = render(<ViewersChart points={[points[1]]} />);
    expect(container.querySelector('[data-testid="viewers-line"]')).toBeNull();
    expect(container.querySelector('[data-testid="viewers-end"]')).not.toBeNull();
  });

  it('sin puntos muestra el estado vacío', () => {
    render(<ViewersChart points={[]} />);
    expect(screen.getByText('Sin datos de asistencia todavía')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('en singular dice "1 espectador"', () => {
    render(<ViewersChart points={[points[0]]} />);
    fireEvent.focus(overlay());
    expect(screen.getByRole('status')).toHaveTextContent('1 espectador');
    expect(screen.getByRole('status')).toHaveTextContent('0 mensajes');
  });
});
