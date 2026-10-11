import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactionBar, REACTIONS } from './ReactionBar';

describe('ReactionBar', () => {
  it('renderiza un botón por reacción', () => {
    render(<ReactionBar onReact={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(REACTIONS.length);
  });

  it('usa el set del documento más tristeza (aplauso, risa, sorpresa, susto, corazón, tristeza)', () => {
    expect([...REACTIONS].sort()).toEqual(['❤️', '👏', '😂', '😮', '😱', '😢'].sort());
    render(<ReactionBar onReact={vi.fn()} />);
    expect(screen.getByRole('button', { name: /corazón/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tristeza/i })).toBeInTheDocument();
  });

  it('limita los clics a 5 por segundo', async () => {
    const onReact = vi.fn();
    render(<ReactionBar onReact={onReact} />);
    const clap = screen.getByRole('button', { name: /👏/ });

    for (let i = 0; i < 8; i++) await userEvent.click(clap);

    expect(onReact).toHaveBeenCalledTimes(5);
    expect(onReact).toHaveBeenCalledWith('👏');
  });
});
