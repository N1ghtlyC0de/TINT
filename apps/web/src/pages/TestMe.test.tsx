import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'framer-motion';
import { quizQuestions } from '../data/quizQuestions';
import TestMe from './TestMe';

MotionGlobalConfig.skipAnimations = true;

function currentQuestion() {
  const prompt = screen.getByRole('heading', { level: 2 }).textContent;
  const q = quizQuestions.find((x) => x.prompt === prompt);
  if (!q) throw new Error(`pregunta no encontrada: ${prompt}`);
  return q;
}

const optionButton = (text: string) => screen.getByRole('button', { name: new RegExp(`^Opción [A-D]: ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });

describe('TestMe', () => {
  beforeEach(() => localStorage.clear());

  it('arranca con las 60 preguntas y sin puntos', () => {
    render(<TestMe />);
    expect(screen.getByRole('heading', { level: 1, name: /Cuánto sabes de TINT/ })).toBeInTheDocument();
    expect(screen.getByText('Pregunta 1 de 60')).toBeInTheDocument();
    expect(screen.getByLabelText('Puntos')).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: 'Todas (60)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('al acertar muestra el panel con la respuesta y las fuentes, y avanza', async () => {
    render(<TestMe />);
    const q = currentQuestion();
    await userEvent.click(optionButton(q.options[q.answer]));
    const panel = screen.getByRole('complementary');
    expect(within(panel).getByRole('status')).toHaveTextContent('¡Correcto!');
    expect(within(panel).getByText(q.sources[0])).toBeInTheDocument();
    expect(screen.getByLabelText('Puntos')).toHaveTextContent('100');
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente pregunta' }));
    expect(screen.getByText('Pregunta 2 de 60')).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('responde con las teclas 1–4 y marca el error', async () => {
    render(<TestMe />);
    const q = currentQuestion();
    // Las opciones se barajan: se busca la posición mostrada de la correcta.
    const labels = screen.getAllByRole('button', { name: /^Opción/ }).map((b) => b.getAttribute('aria-label'));
    const shown = labels.findIndex((l) => l?.endsWith(`: ${q.options[q.answer]}`));
    const wrong = [0, 1, 2, 3].find((i) => i !== shown)!;
    await userEvent.keyboard(String(wrong + 1));
    expect(screen.getByRole('status')).toHaveTextContent('Incorrecto');
    // una segunda tecla no cambia la respuesta
    await userEvent.keyboard(String(shown + 1));
    expect(screen.getByRole('status')).toHaveTextContent('Incorrecto');
  });

  it('filtra por categoría, completa la ronda y permite reintentar', async () => {
    render(<TestMe />);
    await userEvent.click(screen.getByRole('button', { name: 'Procesos, CI y convenciones (5)' }));
    expect(screen.getByText('Pregunta 1 de 5')).toBeInTheDocument();
    for (let i = 0; i < 5; i++) {
      const q = currentQuestion();
      expect(q.category).toBe('procesos');
      await userEvent.click(optionButton(q.options[q.answer]));
      await userEvent.click(screen.getByRole('button', { name: i < 4 ? 'Siguiente pregunta' : 'Ver resultados' }));
    }
    expect(screen.getByRole('heading', { name: 'Arquitecto TINT' })).toBeInTheDocument();
    // 100 + 100 + 200 + 200 + 300
    expect(screen.getByLabelText('Puntos')).toHaveTextContent('900');
    expect(screen.getAllByText('900')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Jugar otra vez' }));
    expect(screen.getByText('Pregunta 1 de 5')).toBeInTheDocument();
  });

  it('recuerda la preferencia de silencio', async () => {
    const { unmount } = render(<TestMe />);
    await userEvent.click(screen.getByRole('button', { name: 'Silenciar sonidos' }));
    unmount();
    render(<TestMe />);
    expect(screen.getByRole('button', { name: 'Activar sonidos' })).toBeInTheDocument();
  });
});
