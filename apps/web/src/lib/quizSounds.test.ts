import { MUTE_KEY, createQuizSounds, defaultAudioContext } from './quizSounds';

function fakeContext(state: AudioContextState = 'running') {
  const oscillators: { type: string; freqs: number[]; started: number; stopped: number }[] = [];
  const param = (log?: number[]) => ({
    setValueAtTime: vi.fn((v: number) => log?.push(v)),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const ctx = {
    state,
    currentTime: 10,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: vi.fn(() => {
      const rec = { type: '', freqs: [] as number[], started: 0, stopped: 0 };
      oscillators.push(rec);
      const osc = {
        set type(t: string) {
          rec.type = t;
        },
        frequency: param(rec.freqs),
        connect: vi.fn((node: unknown) => node),
        start: vi.fn((t: number) => (rec.started = t)),
        stop: vi.fn((t: number) => (rec.stopped = t)),
      };
      return osc;
    }),
    createGain: vi.fn(() => ({ gain: param(), connect: vi.fn((node: unknown) => node) })),
  };
  return { ctx: ctx as unknown as AudioContext, oscillators, raw: ctx };
}

describe('createQuizSounds', () => {
  beforeEach(() => localStorage.clear());

  it('crea el AudioContext de forma perezosa en el primer sonido', () => {
    const { ctx } = fakeContext();
    const factory = vi.fn(() => ctx);
    const sounds = createQuizSounds(factory);
    expect(factory).not.toHaveBeenCalled();
    sounds.correct();
    sounds.wrong();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('el acierto suena ascendente y el error descendente', () => {
    const ok = fakeContext();
    createQuizSounds(() => ok.ctx).correct();
    const up = ok.oscillators.map((o) => o.freqs[0]);
    expect(up.length).toBeGreaterThan(1);
    expect(up[up.length - 1]).toBeGreaterThan(up[0]);
    expect(ok.oscillators[0].started).toBeGreaterThanOrEqual(10);
    expect(ok.oscillators[0].stopped).toBeGreaterThan(ok.oscillators[0].started);

    const ko = fakeContext();
    createQuizSounds(() => ko.ctx).wrong();
    const down = ko.oscillators.map((o) => o.freqs[0]);
    expect(down[down.length - 1]).toBeLessThan(down[0]);
  });

  it('la racha y el final tocan más notas que un acierto', () => {
    const a = fakeContext();
    const s = createQuizSounds(() => a.ctx);
    s.streak();
    const streakNotes = a.oscillators.length;
    s.finish();
    expect(streakNotes).toBeGreaterThan(2);
    expect(a.oscillators.length - streakNotes).toBeGreaterThan(3);
  });

  it('reanuda un contexto suspendido', () => {
    const { ctx, raw } = fakeContext('suspended');
    createQuizSounds(() => ctx).correct();
    expect(raw.resume).toHaveBeenCalled();
  });

  it('en silencio no crea contexto y persiste la preferencia', () => {
    const factory = vi.fn(() => fakeContext().ctx);
    const s = createQuizSounds(factory);
    s.setMuted(true);
    expect(s.isMuted()).toBe(true);
    expect(localStorage.getItem(MUTE_KEY)).toBe('1');
    s.correct();
    expect(factory).not.toHaveBeenCalled();

    expect(createQuizSounds(factory).isMuted()).toBe(true);
    s.setMuted(false);
    expect(localStorage.getItem(MUTE_KEY)).toBeNull();
  });

  it('es no-op si el navegador no soporta Web Audio', () => {
    const factory = vi.fn(() => null);
    const s = createQuizSounds(factory);
    expect(() => {
      s.correct();
      s.finish();
    }).not.toThrow();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('no falla si localStorage lanza', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const s = createQuizSounds(() => null);
    expect(s.isMuted()).toBe(false);
    expect(() => s.setMuted(true)).not.toThrow();
    expect(s.isMuted()).toBe(true);
    spy.mockRestore();
    set.mockRestore();
  });
});

describe('defaultAudioContext', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('devuelve null sin soporte de Web Audio', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(defaultAudioContext()).toBeNull();
  });

  it('instancia AudioContext cuando existe', () => {
    const Ctor = vi.fn();
    vi.stubGlobal('AudioContext', Ctor);
    expect(defaultAudioContext()).toBeInstanceOf(Ctor);
  });

  it('devuelve null si el constructor lanza', () => {
    vi.stubGlobal('AudioContext', vi.fn(() => {
      throw new Error('no');
    }));
    expect(defaultAudioContext()).toBeNull();
  });
});
