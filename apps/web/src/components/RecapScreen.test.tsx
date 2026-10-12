import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RecapScreen } from './RecapScreen';
import type { RecapMessage } from '../lib/socialSocket';

const full: RecapMessage = {
  type: 'recap',
  room_id: 'r1',
  top_emoji_user: { user_id: 'u1', nick: 'Ana', count: 12 },
  most_paused: { position_ms: 65_400, count: 3 },
  peak_reactions: { position_ms: 3_725_000, count: 18, laughs: 9 },
  totals: { reactions: 40, pauses: 5, rewinds: 2, polls: 1 },
};

describe('RecapScreen', () => {
  it('muestra la infografía completa', () => {
    render(<RecapScreen recap={full} onDismiss={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Watch Party Recap' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Ana')).toBeInTheDocument();
    expect(within(dialog).getByText('12 emojis')).toBeInTheDocument();
    expect(within(dialog).getByText('01:05')).toBeInTheDocument();
    expect(within(dialog).getByText('3 pausas y retrocesos')).toBeInTheDocument();
    expect(within(dialog).getByText('62:05')).toBeInTheDocument();
    expect(within(dialog).getByText('18 reacciones · 9 risas')).toBeInTheDocument();
    const totals = within(dialog).getByRole('list', { name: 'Totales de la sesión' });
    expect(within(totals).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '40Reacciones',
      '5Pausas',
      '2Retrocesos',
      '1Encuestas',
    ]);
  });

  it('maneja los nulos con mensajes amables', () => {
    render(
      <RecapScreen
        recap={{ ...full, top_emoji_user: null, most_paused: null, peak_reactions: null, totals: { reactions: 0, pauses: 0, rewinds: 0, polls: 0 } }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Nadie envió emojis esta vez')).toBeInTheDocument();
    expect(screen.getByText('Nadie pausó: ¡atención total!')).toBeInTheDocument();
    expect(screen.getByText('Sin reacciones registradas')).toBeInTheDocument();
  });

  it('singulares', () => {
    render(
      <RecapScreen
        recap={{
          ...full,
          top_emoji_user: { user_id: 'u', nick: 'Leo', count: 1 },
          most_paused: { position_ms: 0, count: 1 },
          peak_reactions: { position_ms: 0, count: 1, laughs: 1 },
        }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('1 emoji')).toBeInTheDocument();
    expect(screen.getByText('1 pausa o retroceso')).toBeInTheDocument();
    expect(screen.getByText('1 reacción · 1 risa')).toBeInTheDocument();
  });

  it('mientras llega el recap muestra un estado de carga', () => {
    render(<RecapScreen recap={null} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Preparando el recap de la sesión…');
  });

  it('se cierra con el botón (con foco inicial) o con Escape', () => {
    const onDismiss = vi.fn();
    render(<RecapScreen recap={full} onDismiss={onDismiss} />);
    const close = screen.getByRole('button', { name: 'Cerrar recap' });
    expect(close).toHaveFocus();
    fireEvent.click(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
