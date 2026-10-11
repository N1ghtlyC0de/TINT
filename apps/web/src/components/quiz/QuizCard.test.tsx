import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'framer-motion';
import type { QuizQuestion } from '../../data/quizQuestions';
import QuizCard from './QuizCard';

MotionGlobalConfig.skipAnimations = true;

const question: QuizQuestion = {
  id: 'x',
  category: 'sync',
  prompt: '¿Qué puerto?',
  options: ['8081', '8082', '8083', '5173'],
  answer: 2,
  explanation: 'porque',
  sources: ['README.md'],
};

describe('QuizCard', () => {
  it('muestra la pregunta, el progreso y las 4 opciones', () => {
    render(<QuizCard question={question} number={3} total={10} selected={null} onAnswer={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '¿Qué puerto?' })).toBeInTheDocument();
    expect(screen.getByText('Pregunta 3 de 10')).toBeInTheDocument();
    expect(screen.getByText('Canal Sync v2')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('notifica la opción elegida', async () => {
    const onAnswer = vi.fn();
    render(<QuizCard question={question} number={1} total={1} selected={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole('button', { name: /Opción B: 8082/ }));
    expect(onAnswer).toHaveBeenCalledWith(1);
  });

  it('tras responder deshabilita las opciones y marca correcta e incorrecta', () => {
    render(<QuizCard question={question} number={1} total={1} selected={1} onAnswer={vi.fn()} />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    expect(screen.getByRole('button', { name: /8083/ })).toHaveAttribute('data-state', 'correct');
    expect(screen.getByRole('button', { name: /8082/ })).toHaveAttribute('data-state', 'wrong');
    expect(screen.getByRole('button', { name: /8081/ })).toHaveAttribute('data-state', 'idle');
  });
});
