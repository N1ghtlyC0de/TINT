import type { QuizQuestion } from '../data/quizQuestions';
import {
  BASE_POINTS,
  buildDeck,
  initialQuizState,
  multiplierFor,
  quizReducer,
  rankFor,
  shuffle,
  shuffleOptions,
  statsByCategory,
} from './quiz';

const q = (id: string, category: QuizQuestion['category'] = 'sync', answer: QuizQuestion['answer'] = 0): QuizQuestion => ({
  id,
  category,
  prompt: `¿${id}?`,
  options: ['a', 'b', 'c', 'd'],
  answer,
  explanation: 'porque sí',
  sources: ['AGENTS.md'],
});

// rng determinista: siempre devuelve 0 → Fisher-Yates intercambia con el índice 0.
const zero = () => 0;

describe('shuffle', () => {
  it('no muta el arreglo original y conserva los elementos', () => {
    const items = [1, 2, 3, 4];
    const out = shuffle(items, zero);
    expect(items).toEqual([1, 2, 3, 4]);
    expect([...out].sort()).toEqual([1, 2, 3, 4]);
  });

  it('es determinista con un rng inyectado', () => {
    expect(shuffle([1, 2, 3, 4], zero)).toEqual(shuffle([1, 2, 3, 4], zero));
    expect(shuffle([1, 2, 3, 4], zero)).toEqual([2, 3, 4, 1]);
  });

  it('usa Math.random por defecto', () => {
    expect(shuffle([1, 2, 3])).toHaveLength(3);
  });
});

describe('shuffleOptions', () => {
  it('reordena las opciones y re-mapea la respuesta correcta', () => {
    const original = q('x', 'sync', 2);
    const out = shuffleOptions(original, zero);
    expect(out.options[out.answer]).toBe(original.options[original.answer]);
    expect([...out.options].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('buildDeck', () => {
  const all = [q('a', 'sync'), q('b', 'datos'), q('c', 'sync')];

  it('filtra por categoría', () => {
    expect(buildDeck(all, 'sync', zero).map((x) => x.id).sort()).toEqual(['a', 'c']);
  });

  it('con "all" incluye todas', () => {
    expect(buildDeck(all, 'all', zero)).toHaveLength(3);
  });
});

describe('puntuación y rangos', () => {
  it('multiplica por racha: x1, x2 desde 3, x3 desde 5', () => {
    expect(multiplierFor(1)).toBe(1);
    expect(multiplierFor(2)).toBe(1);
    expect(multiplierFor(3)).toBe(2);
    expect(multiplierFor(4)).toBe(2);
    expect(multiplierFor(5)).toBe(3);
    expect(multiplierFor(12)).toBe(3);
  });

  it('asigna rangos según el porcentaje', () => {
    expect(rankFor(0)).toBe('Becario del monorepo');
    expect(rankFor(39)).toBe('Becario del monorepo');
    expect(rankFor(40)).toBe('Dev de guardia');
    expect(rankFor(70)).toBe('Tech lead');
    expect(rankFor(90)).toBe('Arquitecto TINT');
    expect(rankFor(100)).toBe('Arquitecto TINT');
  });
});

describe('quizReducer', () => {
  const deck = [q('a', 'sync', 0), q('b', 'datos', 1), q('c', 'sync', 0)];

  it('estado inicial', () => {
    const s = initialQuizState(deck);
    expect(s).toMatchObject({ index: 0, selected: null, score: 0, streak: 0, bestStreak: 0, finished: false });
    expect(s.results).toEqual([]);
  });

  it('una respuesta correcta suma puntos y racha', () => {
    const s = quizReducer(initialQuizState(deck), { type: 'answer', choice: 0 });
    expect(s.selected).toBe(0);
    expect(s.score).toBe(BASE_POINTS);
    expect(s.streak).toBe(1);
    expect(s.results).toEqual([{ id: 'a', category: 'sync', correct: true }]);
  });

  it('una respuesta incorrecta rompe la racha y no suma', () => {
    let s = quizReducer(initialQuizState(deck), { type: 'answer', choice: 0 });
    s = quizReducer(s, { type: 'next' });
    s = quizReducer(s, { type: 'answer', choice: 3 });
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(1);
    expect(s.score).toBe(BASE_POINTS);
    expect(s.results[1].correct).toBe(false);
  });

  it('ignora una segunda respuesta a la misma pregunta', () => {
    const s1 = quizReducer(initialQuizState(deck), { type: 'answer', choice: 0 });
    expect(quizReducer(s1, { type: 'answer', choice: 1 })).toBe(s1);
  });

  it('ignora "next" si aún no se respondió', () => {
    const s0 = initialQuizState(deck);
    expect(quizReducer(s0, { type: 'next' })).toBe(s0);
  });

  it('aplica el multiplicador de racha', () => {
    const long = [q('1'), q('2'), q('3')];
    let s = initialQuizState(long);
    for (let i = 0; i < 3; i++) {
      s = quizReducer(s, { type: 'answer', choice: 0 });
      if (i < 2) s = quizReducer(s, { type: 'next' });
    }
    expect(s.score).toBe(BASE_POINTS * (1 + 1 + 2));
    expect(s.bestStreak).toBe(3);
  });

  it('termina al pasar la última pregunta y reinicia con un nuevo mazo', () => {
    let s = initialQuizState([q('solo')]);
    s = quizReducer(s, { type: 'answer', choice: 0 });
    s = quizReducer(s, { type: 'next' });
    expect(s.finished).toBe(true);
    expect(s.index).toBe(0);
    const r = quizReducer(s, { type: 'restart', questions: deck });
    expect(r).toEqual(initialQuizState(deck));
  });

  it('ignora respuestas cuando el cuestionario terminó o no hay preguntas', () => {
    const empty = initialQuizState([]);
    expect(quizReducer(empty, { type: 'answer', choice: 0 })).toBe(empty);
  });
});

describe('statsByCategory', () => {
  it('cuenta aciertos y total por categoría', () => {
    expect(
      statsByCategory([
        { id: 'a', category: 'sync', correct: true },
        { id: 'b', category: 'sync', correct: false },
        { id: 'c', category: 'datos', correct: true },
      ]),
    ).toEqual({ sync: { correct: 1, total: 2 }, datos: { correct: 1, total: 1 } });
  });
});
