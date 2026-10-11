import { motion } from 'framer-motion';
import { QUIZ_CATEGORIES } from '../../data/quizQuestions';
import { rankFor, statsByCategory, type QuizResult } from '../../lib/quiz';
import { Button } from '../ui/Button';

const CONFETTI_COLORS = ['#FF6B1A', '#FF8A3D', '#23A55A', '#DBDEE1', '#C4520A'];

function Confetti() {
  return (
    <div data-testid="confetti" aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      {Array.from({ length: 36 }, (_, i) => (
        <motion.span
          key={i}
          className="absolute top-0 h-2.5 w-1.5 rounded-sm"
          style={{ left: `${(i * 37) % 100}%`, backgroundColor: CONFETTI_COLORS[i % CONFETTI_COLORS.length] }}
          initial={{ y: -20, rotate: 0, opacity: 1 }}
          animate={{ y: '105vh', rotate: 360 + i * 25, opacity: [1, 1, 0] }}
          transition={{ duration: 2.2 + (i % 5) * 0.3, delay: (i % 9) * 0.08, ease: 'easeIn' }}
        />
      ))}
    </div>
  );
}

export default function QuizSummary({
  score,
  bestStreak,
  results,
  onRestart,
}: {
  score: number;
  bestStreak: number;
  results: QuizResult[];
  onRestart: () => void;
}) {
  const correct = results.filter((r) => r.correct).length;
  const pct = results.length ? Math.round((correct / results.length) * 100) : 0;
  const stats = statsByCategory(results);

  return (
    <motion.section
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 20 }}
      className="rounded-2xl border border-white/10 bg-tint-card/70 p-6 text-center sm:p-8"
    >
      {pct >= 70 && <Confetti />}
      <p className="text-xs font-medium uppercase tracking-wide text-tint-muted">Tu rango</p>
      <h2 className="mt-1 text-3xl font-black text-tint-accent">{rankFor(pct)}</h2>
      <div className="mt-6 grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-white/5 p-3">
          <p className="text-xs text-tint-muted">Puntos</p>
          <p className="text-xl font-bold text-white">{score}</p>
        </div>
        <div className="rounded-xl bg-white/5 p-3">
          <p className="text-xs text-tint-muted">Aciertos</p>
          <p className="text-sm font-bold text-white">
            {correct} / {results.length} ({pct} %)
          </p>
        </div>
        <div className="rounded-xl bg-white/5 p-3">
          <p className="text-xs text-tint-muted">Mejor racha</p>
          <p className="text-xl font-bold text-white">🔥 {bestStreak}</p>
        </div>
      </div>
      <ul className="mt-6 grid gap-2 text-left text-sm">
        {QUIZ_CATEGORIES.filter((c) => stats[c.id]).map((c) => {
          const s = stats[c.id]!;
          return (
            <li key={c.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-4 py-2">
              <span className="text-tint-text">{c.label}</span>
              <span className="font-semibold tabular-nums text-white">
                {s.correct}/{s.total}
              </span>
            </li>
          );
        })}
      </ul>
      <Button onClick={onRestart} className="mt-6">
        Jugar otra vez
      </Button>
    </motion.section>
  );
}
