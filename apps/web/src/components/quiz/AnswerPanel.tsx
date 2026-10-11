import { motion } from 'framer-motion';
import type { QuizQuestion } from '../../data/quizQuestions';
import { Button } from '../ui/Button';

export default function AnswerPanel({
  question,
  selected,
  gained,
  isLast,
  onNext,
}: {
  question: QuizQuestion;
  selected: number;
  gained: number;
  isLast: boolean;
  onNext: () => void;
}) {
  const correct = selected === question.answer;

  return (
    <motion.aside
      initial={{ y: '100%', opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: '100%', opacity: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className={`fixed inset-x-0 bottom-0 z-20 max-h-[70dvh] overflow-y-auto border-t-2 bg-tint-surface/95 px-4 pb-6 pt-5 shadow-2xl backdrop-blur ${correct ? 'border-tint-success' : 'border-red-400'}`}
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <p role="status" className={`text-lg font-bold ${correct ? 'text-tint-success' : 'text-red-300'}`}>
            {correct ? '¡Correcto!' : 'Incorrecto'}
          </p>
          {correct && (
            <motion.span
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 15 }}
              className="rounded-full bg-tint-accent px-3 py-1 text-sm font-bold text-tint-bg"
            >
              +{gained} pts
            </motion.span>
          )}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">Respuesta correcta</p>
          <p className="mt-1 font-semibold text-white">{question.options[question.answer]}</p>
        </div>
        <p className="text-sm leading-relaxed text-tint-text">{question.explanation}</p>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">Dónde encontrarlo</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {question.sources.map((src) => (
              <li key={src}>
                <code className="rounded-lg bg-black/30 px-2 py-1 text-xs text-tint-accentHover">{src}</code>
              </li>
            ))}
          </ul>
        </div>
        <Button autoFocus onClick={onNext} className="self-end">
          {isLast ? 'Ver resultados' : 'Siguiente pregunta'}
        </Button>
      </div>
    </motion.aside>
  );
}
