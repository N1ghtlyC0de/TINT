import type { QuizCategoryId, QuizQuestion } from '../data/quizQuestions';

// Lógica pura del cuestionario /test-me: sin React ni I/O, el azar se inyecta.

export const BASE_POINTS = 100;

export type Rng = () => number;

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function shuffleOptions(question: QuizQuestion, rng: Rng = Math.random): QuizQuestion {
  const order = shuffle([0, 1, 2, 3], rng);
  return {
    ...question,
    options: order.map((i) => question.options[i]) as QuizQuestion['options'],
    answer: order.indexOf(question.answer) as QuizQuestion['answer'],
  };
}

export function buildDeck(all: readonly QuizQuestion[], category: QuizCategoryId | 'all', rng: Rng = Math.random) {
  const pool = category === 'all' ? all : all.filter((q) => q.category === category);
  return shuffle(pool, rng).map((q) => shuffleOptions(q, rng));
}

/** `streak` incluye la respuesta actual: x2 desde 3 seguidas, x3 desde 5. */
export function multiplierFor(streak: number): 1 | 2 | 3 {
  if (streak >= 5) return 3;
  if (streak >= 3) return 2;
  return 1;
}

export function rankFor(pct: number): string {
  if (pct >= 90) return 'Arquitecto TINT';
  if (pct >= 70) return 'Tech lead';
  if (pct >= 40) return 'Dev de guardia';
  return 'Becario del monorepo';
}

export interface QuizResult {
  id: string;
  category: QuizCategoryId;
  correct: boolean;
}

export interface QuizState {
  questions: QuizQuestion[];
  index: number;
  selected: number | null;
  score: number;
  streak: number;
  bestStreak: number;
  results: QuizResult[];
  finished: boolean;
}

export type QuizAction =
  | { type: 'answer'; choice: number }
  | { type: 'next' }
  | { type: 'restart'; questions: QuizQuestion[] };

export function initialQuizState(questions: QuizQuestion[]): QuizState {
  return { questions, index: 0, selected: null, score: 0, streak: 0, bestStreak: 0, results: [], finished: false };
}

export function quizReducer(state: QuizState, action: QuizAction): QuizState {
  switch (action.type) {
    case 'answer': {
      const current = state.questions[state.index];
      if (!current || state.finished || state.selected !== null) return state;
      const correct = action.choice === current.answer;
      const streak = correct ? state.streak + 1 : 0;
      return {
        ...state,
        selected: action.choice,
        score: state.score + (correct ? BASE_POINTS * multiplierFor(streak) : 0),
        streak,
        bestStreak: Math.max(state.bestStreak, streak),
        results: [...state.results, { id: current.id, category: current.category, correct }],
      };
    }
    case 'next': {
      if (state.selected === null) return state;
      const last = state.index >= state.questions.length - 1;
      return { ...state, selected: null, index: last ? state.index : state.index + 1, finished: last };
    }
    case 'restart':
      return initialQuizState(action.questions);
  }
}

export function statsByCategory(results: readonly QuizResult[]) {
  const stats: Partial<Record<QuizCategoryId, { correct: number; total: number }>> = {};
  for (const r of results) {
    const s = (stats[r.category] ??= { correct: 0, total: 0 });
    s.total += 1;
    if (r.correct) s.correct += 1;
  }
  return stats;
}
