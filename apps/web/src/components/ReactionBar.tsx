import { useThrottle } from '../hooks/useThrottle';
import { REACTION_EMOJIS, type ReactionEmoji } from '../lib/socialSocket';

// Set del documento (REQ-20): aplauso, risa, sorpresa, susto, corazón.
export const REACTIONS: readonly ReactionEmoji[] = REACTION_EMOJIS;

const REACTION_LABELS: Record<ReactionEmoji, string> = {
  '👏': 'aplauso',
  '😂': 'risa',
  '😮': 'sorpresa',
  '😱': 'susto',
  '❤️': 'corazón',
};

export type Reaction = ReactionEmoji;

interface ReactionBarProps {
  onReact: (reaction: Reaction) => void;
}

export function ReactionBar({ onReact }: ReactionBarProps) {
  const react = useThrottle(onReact);

  return (
    <div role="toolbar" aria-label="Reacciones" className="flex gap-2">
      {REACTIONS.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => react(r)}
          aria-label={`Reaccionar con ${REACTION_LABELS[r]} ${r}`}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xl transition hover:scale-105 hover:bg-white/10 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent"
        >
          {r}
        </button>
      ))}
    </div>
  );
}
