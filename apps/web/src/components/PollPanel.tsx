import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  POLL_DURATIONS_S,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  pollPercentages,
  validatePollDraft,
  type PollView,
} from '../lib/socialSocket';
import { formatTime } from '../lib/time';
import { Button } from './ui/Button';

export interface PollPanelProps {
  poll: PollView | null;
  /** Solo el host crea y cierra (social-core responde FORBIDDEN al resto). */
  isHost: boolean;
  creatorOpen: boolean;
  onCreatorOpenChange: (open: boolean) => void;
  /** Devuelve false si no se pudo enviar (socket cerrado). */
  onCreate: (question: string, options: string[], durationS: number) => boolean;
  onVote: (pollId: string, option: number) => void;
  onClose: (pollId: string) => void;
  /** Código del último error del canal social. */
  error: string | null;
}

const POLL_ERRORS: Record<string, string> = {
  FORBIDDEN: 'Solo el host puede gestionar encuestas.',
  POLL_ACTIVE: 'Ya hay una encuesta activa: ciérrala antes de lanzar otra.',
  POLL_CLOSED: 'La encuesta ya está cerrada.',
  POLL_NOT_FOUND: 'La encuesta ya no existe.',
  UNAVAILABLE: 'Las encuestas no están disponibles ahora; inténtalo en un momento.',
};

const DURATION_LABELS: Record<number, string> = { 30: '30 s', 60: '1 min', 120: '2 min', 300: '5 min' };

const INPUT_CLASS =
  'w-full rounded-xl border border-white/10 bg-tint-bg px-3 py-2 text-sm text-white placeholder:text-tint-muted/50 focus:border-tint-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60';

const votesLabel = (n: number) => `${n} ${n === 1 ? 'voto' : 'votos'}`;

/** Cuenta atrás solo informativa: el cierre lo decide social-core (`closed`), no el reloj local. */
function Countdown({ closesAtMs }: { closesAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p role="timer" aria-live="off" className="text-[12px] tabular-nums text-tint-muted">
      Quedan {formatTime(Math.max(0, closesAtMs - now))}
    </p>
  );
}

function PollCreator({
  onCreate,
  onCancel,
}: {
  onCreate: (question: string, options: string[], durationS: number) => boolean;
  onCancel: () => void;
}) {
  const ids = useId();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [duration, setDuration] = useState<number>(60);
  const [error, setError] = useState<string | null>(null);
  const questionRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    questionRef.current?.focus();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const invalid = validatePollDraft(question, options, duration);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!onCreate(question.trim(), options.map((o) => o.trim()), duration)) {
      setError('No se pudo enviar la encuesta: el chat está reconectando.');
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-3" aria-label="Nueva encuesta">
      <div>
        <label htmlFor={`${ids}-q`} className="text-[13px] font-medium text-white">
          Pregunta
        </label>
        <input
          ref={questionRef}
          id={`${ids}-q`}
          value={question}
          maxLength={POLL_QUESTION_MAX}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="¿Quién crees que es el culpable?"
          autoComplete="off"
          className={`mt-1 ${INPUT_CLASS}`}
        />
      </div>
      {options.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <label htmlFor={`${ids}-o${i}`} className="sr-only">
            Opción {i + 1}
          </label>
          <input
            id={`${ids}-o${i}`}
            value={value}
            maxLength={POLL_OPTION_MAX}
            onChange={(e) => setOptions((prev) => prev.map((o, j) => (j === i ? e.target.value : o)))}
            placeholder={`Opción ${i + 1}`}
            autoComplete="off"
            className={INPUT_CLASS}
          />
          {options.length > POLL_MIN_OPTIONS && (
            <Button
              type="button"
              variant="quiet"
              className="px-3 py-2"
              aria-label={`Quitar opción ${i + 1}`}
              onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
            >
              <span aria-hidden="true">✕</span>
            </Button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          className="px-3 py-1.5 text-[13px]"
          disabled={options.length >= POLL_MAX_OPTIONS}
          onClick={() => setOptions((prev) => [...prev, ''])}
        >
          Añadir opción
        </Button>
        <label htmlFor={`${ids}-d`} className="ml-auto text-[13px] text-tint-muted">
          Duración
        </label>
        <select
          id={`${ids}-d`}
          value={String(duration)}
          onChange={(e) => setDuration(Number(e.target.value))}
          className="rounded-full border border-white/15 bg-tint-bg px-3 py-1.5 text-[13px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent"
        >
          {POLL_DURATIONS_S.map((d) => (
            <option key={d} value={String(d)}>
              {DURATION_LABELS[d]}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-red-300">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" className="px-4 py-2">
          Lanzar encuesta
        </Button>
        <Button type="button" variant="quiet" className="px-4 py-2" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/**
 * Encuestas en vivo: el host las crea (2–4 opciones, duración) y las cierra; todos votan
 * y ven barras con porcentajes. Conteos, cierre y permisos son de social-core.
 */
export function PollPanel({
  poll,
  isHost,
  creatorOpen,
  onCreatorOpenChange,
  onCreate,
  onVote,
  onClose,
  error,
}: PollPanelProps) {
  const active = poll !== null && !poll.closed;
  const errorText = error ? POLL_ERRORS[error] : undefined;

  const create = (question: string, options: string[], durationS: number) => {
    const ok = onCreate(question, options, durationS);
    if (ok) onCreatorOpenChange(false);
    return ok;
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-white">Encuestas</h2>
        {isHost && !active && !creatorOpen && (
          <Button variant="ghost" className="px-3 py-1.5 text-[13px]" onClick={() => onCreatorOpenChange(true)}>
            Nueva encuesta
          </Button>
        )}
      </div>

      {errorText && (
        <p role="alert" className="mt-2 text-[13px] text-red-300">
          {errorText}
        </p>
      )}

      {isHost && creatorOpen && !active && <PollCreator onCreate={create} onCancel={() => onCreatorOpenChange(false)} />}

      {poll ? (
        <PollCard poll={poll} isHost={isHost} onVote={onVote} onClose={onClose} />
      ) : (
        !creatorOpen && (
          <p className="mt-1 text-[13px] leading-relaxed">
            {isHost
              ? 'Lanza una pregunta rápida a la sala y mira los votos en vivo.'
              : 'El host todavía no ha lanzado ninguna encuesta.'}
          </p>
        )
      )}
    </div>
  );
}

function PollCard({
  poll,
  isHost,
  onVote,
  onClose,
}: {
  poll: PollView;
  isHost: boolean;
  onVote: (pollId: string, option: number) => void;
  onClose: (pollId: string) => void;
}) {
  const percents = pollPercentages(poll.counts);
  const total = poll.counts.reduce((a, b) => a + b, 0);
  const max = Math.max(...poll.counts, 0);

  const bar = (i: number, highlight: boolean) => (
    <span aria-hidden="true" className="mt-1 block h-1.5 overflow-hidden rounded-full bg-white/10">
      <span
        className={`block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${
          highlight ? 'bg-tint-accent' : 'bg-tint-muted/60'
        }`}
        style={{ width: `${percents[i] ?? 0}%` }}
      />
    </span>
  );

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="text-sm font-semibold text-white">{poll.question}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        {poll.closed ? (
          <p className="text-[12px] font-semibold text-tint-accent">Encuesta cerrada</p>
        ) : (
          <Countdown closesAtMs={poll.closes_at_ms} />
        )}
        <p className="text-[12px] tabular-nums text-tint-muted">{votesLabel(total)}</p>
      </div>

      {poll.closed ? (
        <ul aria-label="Resultados" className="mt-2 space-y-2">
          {poll.options.map((label, i) => {
            const winner = total > 0 && poll.counts[i] === max;
            return (
              <li key={i} className="text-[13px]">
                <span className="flex justify-between gap-2">
                  <span className={winner ? 'font-semibold text-white' : ''}>
                    {winner && <span aria-hidden="true">🏆 </span>}
                    {label}
                    {poll.my_vote === i && <span className="text-tint-muted"> (tu voto)</span>}
                  </span>
                  <span className="tabular-nums">{percents[i]} %</span>
                </span>
                {bar(i, winner)}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-2 space-y-2">
          {poll.options.map((label, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={poll.my_vote === i}
              disabled={poll.my_vote !== null}
              onClick={() => onVote(poll.poll_id, i)}
              className={`block w-full rounded-xl border px-3 py-2 text-left text-[13px] text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent disabled:cursor-default ${
                poll.my_vote === i ? 'border-tint-accent bg-tint-accent/15' : 'border-white/10 hover:bg-white/5'
              }`}
            >
              <span className="flex justify-between gap-2">
                <span>{label}</span>
                <span className="tabular-nums text-tint-muted">{percents[i]} %</span>
              </span>
              {bar(i, poll.my_vote === i)}
            </button>
          ))}
        </div>
      )}

      {isHost && !poll.closed && (
        <Button variant="ghost" className="mt-3 px-3 py-1.5 text-[13px]" onClick={() => onClose(poll.poll_id)}>
          Cerrar encuesta
        </Button>
      )}
    </div>
  );
}
