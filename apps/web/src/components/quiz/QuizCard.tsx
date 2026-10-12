import { motion } from 'framer-motion';
import { QUIZ_CATEGORIES, type QuizQuestion } from '../../data/quizQuestions';

const LETTERS = ['A', 'B', 'C', 'D'] as const;

type OptionState = 'idle' | 'correct' | 'wrong' | 'dim';

const optionStyles: Record<OptionState, string> = {
  idle: 'border-white/10 bg-white/5 hover:border-tint-accent/60 hover:bg-white/10',
  correct: 'border-tint-success bg-tint-success/15 text-white',
  wrong: 'border-red-400 bg-red-500/15 text-white',
  dim: 'border-white/5 bg-white/[0.02] opacity-60',
};

export default function QuizCard({
  question,
  number,
  total,
  selected,
  onAnswer,
}: {
  question: QuizQuestion;
  number: number;
  total: number;
  selected: number | null;
  onAnswer: (choice: number) => void;
}) {
  const answered = selected !== null;
  const category = QUIZ_CATEGORIES.find((c) => c.id === question.category)?.label ?? question.category;

  const stateOf = (i: number): OptionState => {
    if (!answered) return 'idle';
    if (i === question.answer) return 'correct';
    if (i === selected) return 'wrong';
    return 'idle';
  };

  return (
    <motion.section
      key={question.id}
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      className="rounded-2xl border border-white/10 bg-tint-card/70 p-6 sm:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide">
        <span className="rounded-full bg-tint-accent/15 px-3 py-1 text-tint-accent">{category}</span>
        <span className="text-tint-muted">
          Pregunta {number} de {total}
        </span>
      </div>
      <h2 className="mt-4 text-lg font-semibold leading-snug text-white sm:text-xl">{question.prompt}</h2>
      <ul className="mt-6 grid gap-3">
        {question.options.map((option, i) => {
          const s = stateOf(i);
          const visual: OptionState = answered && s === 'idle' ? 'dim' : s;
          return (
            <motion.li
              key={option}
              initial={{ opacity: 0, y: 8 }}
              animate={s === 'wrong' ? { opacity: 1, y: 0, x: [0, -8, 8, -4, 4, 0] } : { opacity: 1, y: 0, scale: s === 'correct' ? [1, 1.03, 1] : 1 }}
              transition={{ delay: answered ? 0 : 0.05 * i, duration: 0.35 }}
            >
              <button
                type="button"
                disabled={answered}
                data-state={s}
                aria-label={`Opción ${LETTERS[i]}: ${option}`}
                onClick={() => onAnswer(i)}
                className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm text-tint-text transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent disabled:cursor-default ${optionStyles[visual]}`}
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-bold text-white">
                  {LETTERS[i]}
                </span>
                <span className="break-words">{option}</span>
              </button>
            </motion.li>
          );
        })}
      </ul>
    </motion.section>
  );
}
