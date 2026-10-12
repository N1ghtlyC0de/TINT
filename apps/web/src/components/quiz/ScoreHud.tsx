import { AnimatePresence, motion } from 'framer-motion';
import { multiplierFor } from '../../lib/quiz';

export default function ScoreHud({
  score,
  streak,
  answered,
  total,
  muted,
  onToggleMute,
}: {
  score: number;
  streak: number;
  answered: number;
  total: number;
  muted: boolean;
  onToggleMute: () => void;
}) {
  const multiplier = multiplierFor(streak);
  const pct = total ? (answered / total) * 100 : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <motion.span
            key={score}
            aria-label="Puntos"
            initial={{ scale: 1.25 }}
            animate={{ scale: 1 }}
            className="text-2xl font-bold tabular-nums text-white"
          >
            {score}
          </motion.span>
          <span aria-label="Racha" className="flex items-center gap-1 text-sm font-semibold text-tint-accentHover">
            <motion.span
              aria-hidden
              animate={streak >= 3 ? { scale: [1, 1.3, 1], rotate: [0, -8, 8, 0] } : { scale: 1 }}
              transition={{ duration: 0.6, repeat: streak >= 3 ? Infinity : 0, repeatDelay: 0.8 }}
            >
              🔥
            </motion.span>
            {streak}
          </span>
          <AnimatePresence>
            {multiplier > 1 && (
              <motion.span
                key={multiplier}
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                exit={{ scale: 0 }}
                className="rounded-full bg-tint-accent px-2 py-0.5 text-xs font-black text-tint-bg"
              >
                x{multiplier}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <button
          type="button"
          onClick={onToggleMute}
          aria-label={muted ? 'Activar sonidos' : 'Silenciar sonidos'}
          className="rounded-full p-2 text-lg text-tint-muted transition hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent"
        >
          <span aria-hidden>{muted ? '🔇' : '🔊'}</span>
        </button>
      </div>
      <div
        role="progressbar"
        aria-label="Progreso"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={answered}
        className="h-2 overflow-hidden rounded-full bg-white/10"
      >
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-tint-accentDark to-tint-accentHover"
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  );
}
