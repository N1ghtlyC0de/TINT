import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'framer-motion';
import ScoreHud from './ScoreHud';

MotionGlobalConfig.skipAnimations = true;

describe('ScoreHud', () => {
  it('muestra puntos, progreso y racha', () => {
    render(<ScoreHud score={700} streak={4} answered={6} total={10} muted={false} onToggleMute={vi.fn()} />);
    expect(screen.getByLabelText('Puntos')).toHaveTextContent('700');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '6');
    expect(screen.getByLabelText('Racha')).toHaveTextContent('4');
    expect(screen.getByText('x2')).toBeInTheDocument();
  });

  it('oculta el multiplicador sin racha suficiente', () => {
    render(<ScoreHud score={0} streak={1} answered={0} total={10} muted={false} onToggleMute={vi.fn()} />);
    expect(screen.queryByText(/^x\d$/)).not.toBeInTheDocument();
  });

  it('alterna el sonido', async () => {
    const onToggleMute = vi.fn();
    const { rerender } = render(<ScoreHud score={0} streak={0} answered={0} total={0} muted={false} onToggleMute={onToggleMute} />);
    await userEvent.click(screen.getByRole('button', { name: 'Silenciar sonidos' }));
    expect(onToggleMute).toHaveBeenCalled();
    rerender(<ScoreHud score={0} streak={0} answered={0} total={0} muted onToggleMute={onToggleMute} />);
    expect(screen.getByRole('button', { name: 'Activar sonidos' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});
