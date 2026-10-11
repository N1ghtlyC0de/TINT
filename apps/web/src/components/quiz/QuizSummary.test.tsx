import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'framer-motion';
import QuizSummary from './QuizSummary';

MotionGlobalConfig.skipAnimations = true;

describe('QuizSummary', () => {
  const results = [
    { id: 'a', category: 'sync' as const, correct: true },
    { id: 'b', category: 'sync' as const, correct: true },
    { id: 'c', category: 'datos' as const, correct: false },
  ];

  it('muestra puntaje, aciertos, rango y desglose por categoría', () => {
    render(<QuizSummary score={300} bestStreak={2} results={results} onRestart={vi.fn()} />);
    expect(screen.getByText('300')).toBeInTheDocument();
    expect(screen.getByText('2 / 3 (67 %)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dev de guardia' })).toBeInTheDocument();
    expect(screen.getByText('Canal Sync v2')).toBeInTheDocument();
    expect(screen.getByText('2/2')).toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();
  });

  it('lanza confeti con un puntaje alto y permite reintentar', async () => {
    const onRestart = vi.fn();
    render(<QuizSummary score={1000} bestStreak={3} results={results.slice(0, 2)} onRestart={onRestart} />);
    expect(screen.getByTestId('confetti')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Jugar otra vez' }));
    expect(onRestart).toHaveBeenCalled();
  });

  it('sin resultados no divide por cero ni lanza confeti', () => {
    render(<QuizSummary score={0} bestStreak={0} results={[]} onRestart={vi.fn()} />);
    expect(screen.getByText('0 / 0 (0 %)')).toBeInTheDocument();
    expect(screen.queryByTestId('confetti')).not.toBeInTheDocument();
  });
});
