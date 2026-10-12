import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollPanel, type PollPanelProps } from './PollPanel';
import type { PollView } from '../lib/socialSocket';

const NOW = 1_000_000;

function poll(over: Partial<PollView> = {}): PollView {
  return {
    type: 'poll_state',
    poll_id: 'p1',
    question: '¿Quién es el culpable?',
    options: ['El mayordomo', 'La tía', 'Nadie'],
    counts: [1, 3, 0],
    closes_at_ms: NOW + 42_000,
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
  return { ...utils, props, rerenderWith: (o: Partial<PollPanelProps>) => utils.rerender(<PollPanel {...props} {...o} />) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PollPanel — participante', () => {
  it('sin encuesta muestra un aviso', () => {
    renderPanel();
    expect(screen.getByText('El host todavía no ha lanzado ninguna encuesta.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nueva encuesta' })).not.toBeInTheDocument();
  });

  it('vota y ve resultados en vivo con porcentaje y cuenta atrás', () => {
    const { props, rerenderWith } = renderPanel({ poll: poll() });
    expect(screen.getByText('¿Quién es el culpable?')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('Quedan 0:42');
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole('timer')).toHaveTextContent('Quedan 0:40');
    const option = screen.getByRole('button', { name: /La tía/ });
    expect(option).toHaveTextContent('75 %');
    fireEvent.click(option);
    expect(props.onVote).toHaveBeenCalledWith('p1', 1);
    rerenderWith({ poll: poll({ my_vote: 1, counts: [1, 4, 0] }) });
    expect(screen.getByRole('button', { name: /La tía/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /La tía/ })).toBeDisabled();
    expect(screen.getByText('5 votos')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cerrar encuesta' })).not.toBeInTheDocument();
  });

  it('la cuenta atrás no baja de 0 ni bloquea el voto (decide el servidor)', () => {
    const { props } = renderPanel({ poll: poll({ closes_at_ms: NOW - 5_000 }) });
    expect(screen.getByRole('timer')).toHaveTextContent('Quedan 0:00');
    fireEvent.click(screen.getByRole('button', { name: /El mayordomo/ }));
    expect(props.onVote).toHaveBeenCalledWith('p1', 0);
  });

  it('encuesta cerrada: resultados finales sin votar', () => {
    renderPanel({ poll: poll({ closed: true, counts: [1, 1, 0] }) });
    expect(screen.getByText('Encuesta cerrada')).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    const results = screen.getByRole('list', { name: 'Resultados' });
    expect(within(results).getAllByRole('listitem')).toHaveLength(3);
    expect(within(results).getAllByText('50 %')).toHaveLength(2);
    expect(screen.getByText('2 votos')).toBeInTheDocument();
  });

  it('un solo voto en singular', () => {
    renderPanel({ poll: poll({ closed: true, counts: [1, 0, 0] }) });
    expect(screen.getByText('1 voto')).toBeInTheDocument();
  });

  it.each([
    ['FORBIDDEN', 'Solo el host puede gestionar encuestas.'],
    ['POLL_ACTIVE', 'Ya hay una encuesta activa: ciérrala antes de lanzar otra.'],
    ['POLL_CLOSED', 'La encuesta ya está cerrada.'],
    ['POLL_NOT_FOUND', 'La encuesta ya no existe.'],
    ['UNAVAILABLE', 'Las encuestas no están disponibles ahora; inténtalo en un momento.'],
  ])('muestra el error %s', (code, text) => {
    renderPanel({ error: code });
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });

  it('ignora errores ajenos a las encuestas', () => {
    renderPanel({ error: 'RATE_LIMITED' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('PollPanel — host', () => {
  it('abre el creador', () => {
    const { props } = renderPanel({ isHost: true });
    fireEvent.click(screen.getByRole('button', { name: 'Nueva encuesta' }));
    expect(props.onCreatorOpenChange).toHaveBeenCalledWith(true);
  });

  it('crea una encuesta con 2–4 opciones y duración', () => {
    const { props } = renderPanel({ isHost: true, creatorOpen: true });
    const question = screen.getByLabelText('Pregunta');
    expect(question).toHaveFocus();
    fireEvent.change(question, { target: { value: '¿Final feliz?' } });
    fireEvent.change(screen.getByLabelText('Opción 1'), { target: { value: 'Sí' } });
    fireEvent.change(screen.getByLabelText('Opción 2'), { target: { value: 'No' } });
    expect(screen.queryByRole('button', { name: 'Quitar opción 2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Añadir opción' }));
    fireEvent.click(screen.getByRole('button', { name: 'Añadir opción' }));
    expect(screen.getByRole('button', { name: 'Añadir opción' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Opción 3'), { target: { value: 'Quizá' } });
    fireEvent.click(screen.getByRole('button', { name: 'Quitar opción 4' }));
    expect(screen.queryByLabelText('Opción 4')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Duración'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lanzar encuesta' }));
    expect(props.onCreate).toHaveBeenCalledWith('¿Final feliz?', ['Sí', 'No', 'Quizá'], 120);
    expect(props.onCreatorOpenChange).toHaveBeenCalledWith(false);
  });

  it('valida antes de enviar', () => {
    const { props } = renderPanel({ isHost: true, creatorOpen: true });
    fireEvent.click(screen.getByRole('button', { name: 'Lanzar encuesta' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe la pregunta.');
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('si no se pudo enviar mantiene el formulario abierto', () => {
    const { props } = renderPanel({ isHost: true, creatorOpen: true, onCreate: vi.fn(() => false) });
    fireEvent.change(screen.getByLabelText('Pregunta'), { target: { value: '¿?' } });
    fireEvent.change(screen.getByLabelText('Opción 1'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Opción 2'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lanzar encuesta' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo enviar la encuesta');
    expect(props.onCreatorOpenChange).not.toHaveBeenCalled();
  });

  it('cancelar cierra el creador', () => {
    const { props } = renderPanel({ isHost: true, creatorOpen: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(props.onCreatorOpenChange).toHaveBeenCalledWith(false);
  });

  it('cierra la encuesta activa y no ofrece crear otra mientras dure', () => {
    const { props } = renderPanel({ isHost: true, poll: poll() });
    expect(screen.queryByRole('button', { name: 'Nueva encuesta' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar encuesta' }));
    expect(props.onClose).toHaveBeenCalledWith('p1');
  });

  it('con la encuesta cerrada puede lanzar otra', () => {
    renderPanel({ isHost: true, poll: poll({ closed: true }) });
    expect(screen.getByRole('button', { name: 'Nueva encuesta' })).toBeInTheDocument();
  });
});
