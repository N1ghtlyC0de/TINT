import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriviaView } from '../../hooks/useSocialSocket';
import type { ScheduledTrivia } from '../../lib/socialSocket';
import { TriviaPanel, TriviaPopup } from './TriviaPanel';

const schedule: ScheduledTrivia[] = [
  { trivia_id: 't1', at_ms: 65_000, question: '¿Quién llegó primero?', options: ['Ana', 'Beto'], correct: 0, answer_window_s: 20 },
  { trivia_id: 't2', at_ms: 125_000, question: '¿De qué color era?', options: ['Rojo', 'Azul', 'Verde'], correct: 2, answer_window_s: 20 },
];

const question = {
  type: 'trivia_question' as const,
  trivia_id: 't1',
  question: '¿Quién llegó primero?',
  options: ['Ana', 'Beto', 'Carla'],
  opens_at_ms: 500_000,
  closes_at_ms: 520_000,
};

const empty: TriviaView = { question: null, receivedAt: null, ack: null, result: null, myOption: null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('TriviaPanel — host', () => {
  function renderHost(over: Partial<Parameters<typeof TriviaPanel>[0]> = {}) {
    const props = {
      isHost: true,
      schedule,
      getCurrentMs: () => 83_400,
      onSchedule: vi.fn(() => true),
      onDelete: vi.fn(() => true),
      error: null,
      ...over,
    };
    render(<TriviaPanel {...props} />);
    return props;
  }

  it('lista las preguntas por tiempo y permite eliminarlas', () => {
    const props = renderHost();
    const items = within(screen.getByRole('list', { name: 'Preguntas programadas' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('01:05');
    expect(items[0]).toHaveTextContent('¿Quién llegó primero?');
    expect(items[1]).toHaveTextContent('02:05');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar la pregunta de 02:05' }));
    expect(props.onDelete).toHaveBeenCalledWith('t2');
  });

  it('sin preguntas muestra un estado vacío', () => {
    renderHost({ schedule: [] });
    expect(screen.getByText(/Aún no hay preguntas/)).toBeInTheDocument();
  });

  it('"Agregar pregunta en este momento" toma el tiempo del vídeo y programa la pregunta', () => {
    const props = renderHost();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar pregunta en este momento' }));
    const time = screen.getByLabelText('Momento del vídeo (mm:ss)');
    expect(time).toHaveValue('01:23');
    expect(screen.getByLabelText('Pregunta de trivia')).toHaveFocus();
    fireEvent.change(time, { target: { value: '01:30' } });
    fireEvent.change(screen.getByLabelText('Pregunta de trivia'), { target: { value: '¿Quién ganó?' } });
    fireEvent.change(screen.getByLabelText('Respuesta 1'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Respuesta 2'), { target: { value: 'Beto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Añadir respuesta' }));
    fireEvent.change(screen.getByLabelText('Respuesta 3'), { target: { value: 'Carla' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Respuesta 3 es la correcta' }));
    fireEvent.change(screen.getByLabelText('Tiempo para responder'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Programar pregunta' }));
    expect(props.onSchedule).toHaveBeenCalledWith({
      atMs: 90_000,
      question: '¿Quién ganó?',
      options: ['Ana', 'Beto', 'Carla'],
      correct: 2,
      answerWindowS: 30,
    });
    expect(screen.queryByLabelText('Pregunta de trivia')).not.toBeInTheDocument();
  });

  it('valida el borrador y el tiempo antes de enviar', () => {
    const props = renderHost({ getCurrentMs: () => null });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar pregunta en este momento' }));
    expect(screen.getByLabelText('Momento del vídeo (mm:ss)')).toHaveValue('00:00');
    fireEvent.click(screen.getByRole('button', { name: 'Programar pregunta' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe la pregunta.');
    fireEvent.change(screen.getByLabelText('Momento del vídeo (mm:ss)'), { target: { value: 'ayer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Programar pregunta' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/mm:ss/);
    expect(props.onSchedule).not.toHaveBeenCalled();
  });

  it('se pueden quitar respuestas hasta dejar 2 y cancelar el formulario', () => {
    renderHost();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar pregunta en este momento' }));
    fireEvent.click(screen.getByRole('button', { name: 'Añadir respuesta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Añadir respuesta' }));
    expect(screen.queryByRole('button', { name: 'Añadir respuesta' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Respuesta 4 es la correcta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quitar respuesta 4' }));
    expect(screen.getByRole('radio', { name: 'Respuesta 1 es la correcta' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Quitar respuesta 3' }));
    expect(screen.queryByRole('button', { name: /Quitar respuesta/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByLabelText('Pregunta de trivia')).not.toBeInTheDocument();
  });

  it('si el canal no está listo lo avisa sin cerrar el formulario', () => {
    renderHost({ onSchedule: vi.fn(() => false) });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar pregunta en este momento' }));
    fireEvent.change(screen.getByLabelText('Pregunta de trivia'), { target: { value: '¿Q?' } });
    fireEvent.change(screen.getByLabelText('Respuesta 1'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Respuesta 2'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Programar pregunta' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/conexión/);
    expect(screen.getByLabelText('Pregunta de trivia')).toBeInTheDocument();
  });

  it('muestra errores del canal relacionados con la trivia', () => {
    renderHost({ error: 'TRIVIA_NOT_FOUND' });
    expect(screen.getByRole('alert')).toHaveTextContent('Esa pregunta ya no existe.');
  });
});

describe('TriviaPanel — invitado', () => {
  it('explica cómo funciona, sin herramientas del host', () => {
    render(<TriviaPanel isHost={false} schedule={[]} getCurrentMs={() => 0} onSchedule={vi.fn()} onDelete={vi.fn()} error={null} />);
    expect(screen.getByText(/aparecerán preguntas/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agregar pregunta en este momento' })).not.toBeInTheDocument();
  });
});

describe('TriviaPopup', () => {
  const base = { onAnswer: vi.fn(() => true), onDismiss: vi.fn(), error: null, isHost: false };

  it('sin trivia no muestra nada', () => {
    const { container } = render(<TriviaPopup trivia={empty} {...base} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('muestra la pregunta con cuenta regresiva y envía la respuesta', () => {
    const onAnswer = vi.fn(() => true);
    render(<TriviaPopup trivia={{ ...empty, question, receivedAt: 1_000_000 }} {...base} onAnswer={onAnswer} />);
    const card = screen.getByRole('region', { name: 'Trivia' });
    expect(within(card).getByText('¡Responde rápido: más puntos!')).toBeInTheDocument();
    expect(within(card).getByText('¿Quién llegó primero?')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('20 s');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('timer')).toHaveTextContent('15 s');
    fireEvent.click(screen.getByRole('button', { name: 'Beto' }));
    expect(onAnswer).toHaveBeenCalledWith('t1', 1);
  });

  it('tras responder marca la elección y bloquea las opciones', () => {
    render(<TriviaPopup trivia={{ ...empty, question, receivedAt: 1_000_000, myOption: 2 }} {...base} />);
    expect(screen.getByRole('button', { name: 'Carla' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Ana' })).toBeDisabled();
    expect(screen.getByText('Respuesta enviada. Espera el resultado…')).toBeInTheDocument();
  });

  it('al acabarse el tiempo sin resultado lo dice', () => {
    render(<TriviaPopup trivia={{ ...empty, question, receivedAt: 1_000_000 - 30_000 }} {...base} />);
    expect(screen.getByText('Se acabó el tiempo. Esperando el resultado…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ana' })).toBeDisabled();
  });

  it('el host ve la pregunta en curso sin poder responder', () => {
    render(<TriviaPopup trivia={{ ...empty, question, receivedAt: 1_000_000 }} {...base} isHost />);
    expect(screen.getByText('Pregunta en curso: tus invitados están respondiendo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ana' })).not.toBeInTheDocument();
  });

  it('muestra la correcta, los puntos propios y el top 10', () => {
    const onDismiss = vi.fn();
    const top = Array.from({ length: 12 }, (_, i) => ({ user_id: `u${i}`, nick: `Jugador ${i + 1}`, score: 2000 - i * 100 }));
    render(
      <TriviaPopup
        trivia={{
          ...empty,
          question,
          receivedAt: 1_000_000,
          myOption: 1,
          result: { type: 'trivia_result', trivia_id: 't1', correct: 1, top, my_score: 1700 },
        }}
        {...base}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText('Respuesta correcta:')).toBeInTheDocument();
    expect(screen.getByText('Beto')).toBeInTheDocument();
    expect(screen.getByText('¡Acertaste! Tus puntos: 1700')).toBeInTheDocument();
    const ranking = screen.getByRole('list', { name: 'Top 10' });
    expect(within(ranking).getAllByRole('listitem')).toHaveLength(10);
    expect(within(ranking).getAllByRole('listitem')[0]).toHaveTextContent('Jugador 1');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar trivia' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('si falló o no respondió lo dice con amabilidad', () => {
    const result = { type: 'trivia_result' as const, trivia_id: 't1', correct: 0, top: [] };
    const { rerender } = render(
      <TriviaPopup trivia={{ ...empty, question, receivedAt: 1, myOption: 2, result }} {...base} />,
    );
    expect(screen.getByText('Esta vez no. Tus puntos: 0')).toBeInTheDocument();
    expect(screen.getByText('Nadie sumó puntos en esta pregunta.')).toBeInTheDocument();
    rerender(<TriviaPopup trivia={{ ...empty, question, receivedAt: 1, result }} {...base} />);
    expect(screen.getByText('No respondiste esta vez.')).toBeInTheDocument();
    rerender(<TriviaPopup trivia={{ ...empty, question, receivedAt: 1, result }} {...base} isHost />);
    expect(screen.queryByText('No respondiste esta vez.')).not.toBeInTheDocument();
  });

  it('muestra los errores de la trivia', () => {
    render(<TriviaPopup trivia={{ ...empty, question, receivedAt: 1_000_000 }} {...base} error="ALREADY_ANSWERED" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Ya respondiste esta pregunta.');
  });
});
