import { useCallback, useReducer } from 'react';
import type { QuizQuestion } from '../data/quizQuestions';
import { initialQuizState, multiplierFor, quizReducer } from '../lib/quiz';
import type { QuizSounds } from '../lib/quizSounds';

// Estado del cuestionario + efectos de sonido. Los sonidos se deciden con el
// estado previo para no depender del orden de los renders.
export function useQuiz(questions: QuizQuestion[], sounds: QuizSounds) {
  const [state, dispatch] = useReducer(quizReducer, questions, initialQuizState);

  const answer = useCallback(
    (choice: number) => {
      const current = state.questions[state.index];
      if (!current || state.finished || state.selected !== null) return;
      if (choice !== current.answer) sounds.wrong();
      else if (multiplierFor(state.streak + 1) > multiplierFor(state.streak)) sounds.streak();
      else sounds.correct();
      dispatch({ type: 'answer', choice });
    },
    [state, sounds],
  );

  const next = useCallback(() => {
    if (state.selected !== null && state.index >= state.questions.length - 1) sounds.finish();
    dispatch({ type: 'next' });
  }, [state, sounds]);

  const restart = useCallback((deck: QuizQuestion[]) => dispatch({ type: 'restart', questions: deck }), []);

  return { state, answer, next, restart };
}
