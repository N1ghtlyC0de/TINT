// Efectos de sonido del cuestionario /test-me sintetizados con Web Audio:
// sin archivos de audio ni dependencias. El contexto se crea en el primer sonido
// (siempre tras un gesto del usuario, como exigen los navegadores).

export const MUTE_KEY = 'tint_quiz_muted';

type Note = { freq: number; at: number; dur: number; type?: OscillatorType };

const SOUNDS: Record<'correct' | 'wrong' | 'streak' | 'finish', Note[]> = {
  correct: [
    { freq: 660, at: 0, dur: 0.09 },
    { freq: 990, at: 0.08, dur: 0.14 },
  ],
  wrong: [
    { freq: 220, at: 0, dur: 0.14, type: 'sawtooth' },
    { freq: 165, at: 0.12, dur: 0.22, type: 'sawtooth' },
  ],
  streak: [
    { freq: 784, at: 0, dur: 0.07 },
    { freq: 988, at: 0.06, dur: 0.07 },
    { freq: 1175, at: 0.12, dur: 0.07 },
    { freq: 1568, at: 0.18, dur: 0.16 },
  ],
  finish: [
    { freq: 523, at: 0, dur: 0.12 },
    { freq: 659, at: 0.12, dur: 0.12 },
    { freq: 784, at: 0.24, dur: 0.12 },
    { freq: 1047, at: 0.36, dur: 0.2 },
    { freq: 784, at: 0.56, dur: 0.1 },
    { freq: 1047, at: 0.66, dur: 0.35 },
  ],
};

export interface QuizSounds {
  correct(): void;
  wrong(): void;
  streak(): void;
  finish(): void;
  isMuted(): boolean;
  setMuted(muted: boolean): void;
}

export function defaultAudioContext(): AudioContext | null {
  try {
    const Ctor = globalThis.AudioContext;
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function createQuizSounds(factory: () => AudioContext | null = defaultAudioContext): QuizSounds {
  let muted = readMuted();
  let ctx: AudioContext | null = null;
  let resolved = false;

  const context = () => {
    if (!resolved) {
      ctx = factory();
      resolved = true;
    }
    return ctx;
  };

  const play = (notes: Note[]) => {
    if (muted) return;
    const ac = context();
    if (!ac) return;
    if (ac.state === 'suspended') void ac.resume();
    const t0 = ac.currentTime;
    for (const n of notes) {
      const start = t0 + n.at;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = n.type ?? 'triangle';
      osc.frequency.setValueAtTime(n.freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + n.dur + 0.02);
    }
  };

  return {
    correct: () => play(SOUNDS.correct),
    wrong: () => play(SOUNDS.wrong),
    streak: () => play(SOUNDS.streak),
    finish: () => play(SOUNDS.finish),
    isMuted: () => muted,
    setMuted(next) {
      muted = next;
      try {
        if (next) localStorage.setItem(MUTE_KEY, '1');
        else localStorage.removeItem(MUTE_KEY);
      } catch {
        // Preferencia solo en memoria si el almacenamiento está bloqueado.
      }
    },
  };
}
