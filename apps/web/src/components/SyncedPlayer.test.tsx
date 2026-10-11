import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncedPlayer, type SyncedPlayerProps } from './SyncedPlayer';
import type { SyncSocketApi } from '../hooks/useSyncSocket';
import type { SyncSnapshot } from '../lib/syncProtocol';

const SRC = 'https://cdn.test/demo.mp4';

function makeSync(over: Partial<SyncSocketApi> = {}): SyncSocketApi {
  return {
    connected: true,
    state: null,
    hostOnline: true,
    lastError: null,
    correction: null,
    canControl: true,
    rttMs: null,
    driftMs: null,
    revoked: false,
    reconnect: null,
    lastBroadcast: null,
    sendCommand: vi.fn(() => 'evt'),
    ...over,
  };
}

const playingState: SyncSnapshot = {
  status: 'playing',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 2,
  server_time_ms: 1_000,
  media_id: '',
  received_at_perf: 0,
};

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderPlayer(props: Partial<SyncedPlayerProps> = {}) {
  const videoRef = createRef<HTMLVideoElement>();
  const sync = props.sync ?? makeSync();
  const utils = render(
    <SyncedPlayer src={SRC} canControl sync={sync} videoRef={videoRef} now={() => 0} {...props} />,
  );
  return { ...utils, videoRef, sync };
}

function video(): HTMLVideoElement {
  return screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;
}

describe('SyncedPlayer — render', () => {
  it('renderiza el vídeo sin controles nativos', () => {
    const { videoRef } = renderPlayer();
    expect(video()).toHaveAttribute('src', SRC);
    expect(video()).not.toHaveAttribute('controls');
    expect(videoRef.current).toBe(video());
  });

  it('muestra un mensaje si no hay vídeo configurado', () => {
    renderPlayer({ src: undefined });
    expect(screen.getByText('Sin video configurado')).toBeInTheDocument();
    expect(screen.queryByLabelText('Vídeo de la sala')).not.toBeInTheDocument();
  });

  it('muestra "Host desconectado" cuando el host se cae', () => {
    renderPlayer({ sync: makeSync({ hostOnline: false }) });
    expect(screen.getByText('Host desconectado')).toBeInTheDocument();
  });

  it('no muestra el badge si el host está en línea', () => {
    renderPlayer();
    expect(screen.queryByText('Host desconectado')).not.toBeInTheDocument();
  });

  it('muestra errores del servidor', () => {
    renderPlayer({ sync: makeSync({ lastError: 'FORBIDDEN' }) });
    expect(screen.getByRole('alert')).toHaveTextContent(/permiso/i);
  });

  it.each([
    ['RATE_LIMITED', /demasiados/i],
    ['INVALID', /inválido/i],
    ['INTERNAL', /servidor/i],
    ['TICKET', /ticket/i],
    ['NO_TOKEN', /sesión/i],
  ])('mensaje para %s', (code, re) => {
    renderPlayer({ sync: makeSync({ lastError: code }) });
    expect(screen.getByRole('alert')).toHaveTextContent(re);
  });
});

describe('SyncedPlayer — controles', () => {
  it('host envía PLAY y PAUSE con la posición actual', () => {
    const { sync } = renderPlayer();
    video().currentTime = 3.2;
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir' }));
    expect(sync.sendCommand).toHaveBeenCalledWith('PLAY', 3_200);
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(sync.sendCommand).toHaveBeenCalledWith('PAUSE', 3_200);
    // El cliente no es autoritativo: espera al broadcast para reproducir.
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('host busca con la barra de progreso al soltar', () => {
    const { sync } = renderPlayer();
    Object.defineProperty(video(), 'duration', { configurable: true, value: 60 });
    fireEvent.loadedMetadata(video());
    const slider = screen.getByRole('slider', { name: 'Buscar posición' });
    expect(slider).toHaveAttribute('aria-valuemax', '60000');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(sync.sendCommand).not.toHaveBeenCalled();
    fireEvent.keyUp(slider, { key: 'End' });
    expect(sync.sendCommand).toHaveBeenCalledWith('SEEK', 60_000);
  });

  it('soltar sin arrastrar no envía SEEK', () => {
    const { sync } = renderPlayer();
    fireEvent.pointerUp(screen.getByRole('slider', { name: 'Buscar posición' }));
    expect(sync.sendCommand).not.toHaveBeenCalled();
  });

  it('participante ve controles deshabilitados y progreso de solo lectura', () => {
    const { sync } = renderPlayer({ canControl: false });
    const play = screen.getByRole('button', { name: 'Reproducir' });
    expect(play).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Progreso' })).toBeInTheDocument();
    fireEvent.click(play);
    expect(sync.sendCommand).not.toHaveBeenCalled();
  });

  it('actualiza el progreso con timeupdate', () => {
    renderPlayer({ canControl: false });
    Object.defineProperty(video(), 'duration', { configurable: true, value: 100 });
    video().currentTime = 25;
    fireEvent.timeUpdate(video());
    expect(screen.getByRole('progressbar', { name: 'Progreso' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('0:25 / 1:40')).toBeInTheDocument();
  });

  it('deshabilita los controles del host si no hay conexión', () => {
    renderPlayer({ sync: makeSync({ connected: false }) });
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeDisabled();
  });
});

describe('SyncedPlayer — aplicar estado', () => {
  it('posiciona y reproduce según el estado maestro', () => {
    renderPlayer({
      sync: makeSync({ state: { ...playingState, received_at_perf: 0 } }),
      now: () => 500,
    });
    expect(video().currentTime).toBeCloseTo(10.5);
    expect(playSpy).toHaveBeenCalled();
  });

  it('pausa cuando el estado está en pausa', () => {
    renderPlayer({ sync: makeSync({ state: { ...playingState, status: 'paused' } }) });
    expect(video().currentTime).toBe(10);
    expect(pauseSpy).toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('si el navegador bloquea autoplay ofrece unirse', async () => {
    playSpy.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    renderPlayer({ sync: makeSync({ state: playingState }) });
    const join = await screen.findByRole('button', { name: 'Unirse a la reproducción' });
    playSpy.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(join);
    });
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Unirse a la reproducción' })).not.toBeInTheDocument();
  });

  it('si unirse también falla mantiene el botón', async () => {
    playSpy.mockRejectedValue(new Error('blocked'));
    renderPlayer({ sync: makeSync({ state: playingState }) });
    const join = await screen.findByRole('button', { name: 'Unirse a la reproducción' });
    await act(async () => {
      fireEvent.click(join);
    });
    expect(screen.getByRole('button', { name: 'Unirse a la reproducción' })).toBeInTheDocument();
  });

  it('tolera play() sin promesa (navegadores antiguos)', () => {
    playSpy.mockReturnValue(undefined as unknown as Promise<void>);
    renderPlayer({ sync: makeSync({ state: playingState }) });
    expect(screen.queryByRole('button', { name: 'Unirse a la reproducción' })).not.toBeInTheDocument();
  });
});

describe('SyncedPlayer — correcciones', () => {
  it('seek reposiciona el vídeo', () => {
    renderPlayer({
      sync: makeSync({
        correction: { seq: 1, target_ms: 42_000, strategy: 'seek', drift_ms: 900, version: 1 },
      }),
    });
    expect(video().currentTime).toBe(42);
  });

  it('rate acelera y restaura al alcanzar la posición esperada', () => {
    vi.useFakeTimers();
    let perf = 0;
    renderPlayer({
      sync: makeSync({
        state: playingState,
        correction: { seq: 1, target_ms: 10_000, strategy: 'rate', drift_ms: -300, version: 2 },
      }),
      now: () => perf,
    });
    expect(video().playbackRate).toBe(1.05);
    // Sigue atrasado: mantiene la corrección.
    video().currentTime = 9;
    perf = 250;
    act(() => vi.advanceTimersByTime(250));
    expect(video().playbackRate).toBe(1.05);
    // Alcanza la posición esperada (10_000 + 500 ms) → restaura.
    perf = 500;
    video().currentTime = 10.45;
    fireEvent.timeUpdate(video());
    expect(video().playbackRate).toBe(1);
  });

  it('rate restaura tras 5 s como máximo', () => {
    vi.useFakeTimers();
    let perf = 0;
    renderPlayer({
      sync: makeSync({
        correction: { seq: 1, target_ms: 0, strategy: 'rate', drift_ms: 300, version: 1 },
      }),
      now: () => perf,
    });
    expect(video().playbackRate).toBe(0.95);
    perf = 4_000;
    act(() => vi.advanceTimersByTime(4_000));
    expect(video().playbackRate).toBe(0.95);
    perf = 5_000;
    act(() => vi.advanceTimersByTime(1_000));
    expect(video().playbackRate).toBe(1);
  });

  it('un nuevo estado cancela la corrección de velocidad', () => {
    vi.useFakeTimers();
    const correction = { seq: 1, target_ms: 0, strategy: 'rate' as const, drift_ms: 300, version: 1 };
    const { rerender, videoRef } = renderPlayer({ sync: makeSync({ correction }) });
    expect(video().playbackRate).toBe(0.95);
    rerender(
      <SyncedPlayer
        src={SRC}
        canControl
        videoRef={videoRef}
        now={() => 0}
        sync={makeSync({ correction, state: { ...playingState, status: 'paused', version: 3 } })}
      />,
    );
    expect(video().playbackRate).toBe(1);
  });
});
