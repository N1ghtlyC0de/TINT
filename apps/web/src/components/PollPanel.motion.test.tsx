import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PollPanel, type PollPanelProps } from './PollPanel';
import type { PollView } from '../lib/socialSocket';

// Archivo aparte con temporizadores reales: el frameloop de framer (requestAnimationFrame)
// es global y quedaría atascado tras las pruebas con temporizadores falsos.

function poll(over: Partial<PollView> = {}): PollView {
  return {
    type: 'poll_state',
    poll_id: 'p1',
    question: '¿Quién es el culpable?',
    options: ['El mayordomo', 'La tía', 'Nadie'],
    counts: [1, 3, 0],
    closes_at_ms: Date.now() + 42_000,
    closed: false,
    my_vote: null,
    ...over,
  };
}

function renderPanel(over: Partial<PollPanelProps> = {}) {
  const props: PollPanelProps = {
    poll: null,
    isHost: false,
    creatorOpen: false,
    onCreatorOpenChange: vi.fn(),
    onCreate: vi.fn(() => true),
    onVote: vi.fn(),
    onClose: vi.fn(),
    error: null,
    ...over,
  };
  const utils = render(<PollPanel {...props} />);
  return { ...utils, rerenderWith: (o: Partial<PollPanelProps>) => utils.rerender(<PollPanel {...props} {...o} />) };
}

describe('PollPanel — movimiento', () => {
  it('las barras animan su ancho hasta el porcentaje (también en resultados)', async () => {
    const { rerenderWith } = renderPanel({ poll: poll() });
    const bar = screen.getByRole('button', { name: /La tía/ }).querySelector('[data-bar]') as HTMLElement;
    expect(bar).not.toBeNull();
    await waitFor(() => expect(bar.style.width).toBe('75%'));
    rerenderWith({ poll: poll({ closed: true, counts: [1, 1, 0] }) });
    const results = screen.getByRole('list', { name: 'Resultados' });
    const bars = results.querySelectorAll<HTMLElement>('[data-bar]');
    await waitFor(() => expect([...bars].map((b) => b.style.width)).toEqual(['50%', '50%', '0%']));
  });

  it('la opción votada lleva anillo de acento y un ✓ decorativo', () => {
    renderPanel({ poll: poll({ my_vote: 1 }) });
    const voted = screen.getByRole('button', { name: /La tía/ });
    expect(voted.className).toContain('ring-2');
    const check = voted.querySelector('[data-check]');
    expect(check).toHaveAttribute('aria-hidden', 'true');
    expect(check).toHaveTextContent('✓');
    expect(screen.getByRole('button', { name: /El mayordomo/ }).querySelector('[data-check]')).toBeNull();
  });

  it('el creador se despliega en un contenedor que colapsa y usa Input', async () => {
    const { rerenderWith } = renderPanel({ isHost: true, creatorOpen: true });
    const form = screen.getByRole('form', { name: 'Nueva encuesta' });
    expect(form.parentElement?.className).toContain('overflow-hidden');
    expect(screen.getByLabelText('Pregunta').className).toContain('backdrop-blur-sm');
    rerenderWith({ creatorOpen: false });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Nueva encuesta' })).not.toBeInTheDocument());
  });
});
