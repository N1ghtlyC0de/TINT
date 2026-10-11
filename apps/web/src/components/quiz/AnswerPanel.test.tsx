import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'framer-motion';
import type { QuizQuestion } from '../../data/quizQuestions';
import AnswerPanel from './AnswerPanel';

MotionGlobalConfig.skipAnimations = true;

const question: QuizQuestion = {
  id: 'x',
  category: 'sync',
  prompt: '¿Qué puerto?',
  options: ['8081', '8082', '8083', '5173'],
  answer: 2,
  explanation: 'social-core ya usaba el 8082',
  sources: ['README.md', 'docs/dominio-reproduccion.md'],
};

describe('AnswerPanel', () => {
  it('en un acierto felicita y muestra los puntos ganados', () => {
    render(<AnswerPanel question={question} selected={2} gained={200} isLast={false} onNext={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('¡Correcto!');
    expect(screen.getByText('+200 pts')).toBeInTheDocument();
  });

  it('en un error muestra la respuesta correcta, la explicación y las fuentes', () => {
    render(<AnswerPanel question={question} selected={0} gained={0} isLast={false} onNext={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Incorrecto');
    expect(screen.getByText('8083')).toBeInTheDocument();
    expect(screen.getByText('social-core ya usaba el 8082')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('docs/dominio-reproduccion.md')).toBeInTheDocument();
    expect(screen.queryByText(/pts$/)).not.toBeInTheDocument();
  });

  it('avanza con el botón y cambia el texto en la última pregunta', async () => {
    const onNext = vi.fn();
    const { rerender } = render(<AnswerPanel question={question} selected={2} gained={100} isLast={false} onNext={onNext} />);
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente pregunta' }));
    expect(onNext).toHaveBeenCalled();
    rerender(<AnswerPanel question={question} selected={2} gained={100} isLast onNext={onNext} />);
    expect(screen.getByRole('button', { name: 'Ver resultados' })).toBeInTheDocument();
  });
});
