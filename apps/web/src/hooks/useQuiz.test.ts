import { act, renderHook } from '@testing-library/react';
import type { QuizQuestion } from '../data/quizQuestions';
import type { QuizSounds } from '../lib/quizSounds';
import { useQuiz } from './useQuiz';

const q = (id: string): QuizQuestion => ({
  id,
  category: 'sync',
  prompt: id,
  options: ['a', 'b', 'c', 'd'],
  answer: 0,
  explanation: 'x',
  sources: ['AGENTS.md'],
});

function fakeSounds(): QuizSounds {
  return {
    correct: vi.fn(),
    wrong: vi.fn(),
    streak: vi.fn(),
    finish: vi.fn(),
    isMuted: vi.fn(() => false),
    setMuted: vi.fn(),
  };
}

describe('useQuiz', () => {
  it('toca el sonido de acierto y de error', () => {
    const sounds = fakeSounds();
    const { result } = renderHook(() => useQuiz([q('1'), q('2')], sounds));
    act(() => result.current.answer(0));
    expect(sounds.correct).toHaveBeenCalledTimes(1);
    act(() => result.current.next());
    act(() => result.current.answer(2));
    expect(sounds.wrong).toHaveBeenCalledTimes(1);
  });

  it('toca la fanfarria de racha al subir el multiplicador (3 y 5 seguidas)', () => {
    const sounds = fakeSounds();
    const deck = [1, 2, 3, 4, 5, 6].map((n) => q(String(n)));
    const { result } = renderHook(() => useQuiz(deck, sounds));
    for (let i = 0; i < 5; i++) {
      act(() => result.current.answer(0));
      act(() => result.current.next());
    }
    expect(sounds.streak).toHaveBeenCalledTimes(2);
    expect(sounds.correct).toHaveBeenCalledTimes(3);
  });

  it('ignora respuestas repetidas y toca el final al terminar', () => {
    const sounds = fakeSounds();
    const { result } = renderHook(() => useQuiz([q('1')], sounds));
    act(() => result.current.answer(0));
    act(() => result.current.answer(1));
    expect(sounds.correct).toHaveBeenCalledTimes(1);
    expect(sounds.wrong).not.toHaveBeenCalled();
    act(() => result.current.next());
    expect(result.current.state.finished).toBe(true);
    expect(sounds.finish).toHaveBeenCalledTimes(1);
  });

  it('reinicia con un mazo nuevo', () => {
    const { result } = renderHook(() => useQuiz([q('1')], fakeSounds()));
    act(() => result.current.answer(0));
    act(() => result.current.restart([q('a'), q('b')]));
    expect(result.current.state.questions.map((x) => x.id)).toEqual(['a', 'b']);
    expect(result.current.state.score).toBe(0);
  });
});
