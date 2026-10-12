import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncedPlayer, type SyncedPlayerProps } from './SyncedPlayer';
import type { SyncSocketApi } from '../hooks/useSyncSocket';
import type { SyncSnapshot } from '../lib/syncProtocol';
import type { PlaybackQuality } from '../lib/quality';

const SRC = 'https://minio/m1/source.mp4?sig=1';
const QUALITIES: PlaybackQuality[] = [
  { id: 'source', label: 'Original', url: SRC },
  { id: '720p', label: '720p', url: 'https://minio/m1/720p.mp4?sig=1' },
  { id: '360p', label: '360p', url: 'https://minio/m1/360p.mp4?sig=1' },
];

const pausedState: SyncSnapshot = {
  status: 'paused',
  position_ms: 20_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 2,
  server_time_ms: 1_000,
  media_id: 'm1',
  received_at_perf: 0,
};

function makeSync(over: Partial<SyncSocketApi> = {}): SyncSocketApi {
  return {
    connected: true,
    state: pausedState,
    hostOnline: true,
    lastError: null,
    correction: null,
    canControl: true,
    rttMs: null,
    driftMs: null,
    revoked: false,
    expired: false,
    fatalError: null,
    reconnect: null,
    lastBroadcast: null,
    volume: 1,
    quality: 'auto',
    sendCommand: vi.fn(() => 'evt'),
    ...over,
  };
}

function renderPlayer(props: Partial<SyncedPlayerProps> = {}) {
  const videoRef = createRef<HTMLVideoElement>();
  const sync = props.sync ?? makeSync();
  const all = { src: SRC, canControl: true, sync, videoRef, now: () => 0, ...props } as SyncedPlayerProps;
  const utils = render(<SyncedPlayer {...all} />);
  const rerenderWith = (over: Partial<SyncedPlayerProps>) => utils.rerender(<SyncedPlayer {...all} {...over} />);
  return { ...utils, videoRef, sync, rerenderWith };
}

function video(): HTMLVideoElement {
  return screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SyncedPlayer — volumen maestro', () => {
  it('aplica el volumen maestro al <video> de todos', () => {
    const { rerenderWith, sync } = renderPlayer({ canControl: false, sync: makeSync({ canControl: false, volume: 0.4 }) });
    expect(video().volume).toBeCloseTo(0.4);
    rerenderWith({ sync: { ...sync, volume: 0.1 } });
    expect(video().volume).toBeCloseTo(0.1);
  });

  it('el invitado puede silenciar solo para sí', async () => {
    const user = userEvent.setup();
    renderPlayer({ canControl: false, sync: makeSync({ canControl: false, volume: 0.7 }) });
    const mute = screen.getByRole('button', { name: 'Silenciar solo para mí' });
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    await user.click(mute);
    expect(video().muted).toBe(true);
    expect(video().volume).toBeCloseTo(0.7);
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    await user.click(mute);
    expect(video().muted).toBe(false);
  });

  it('quien controla no ve el silencio local (usa la barra del host)', () => {
    renderPlayer();
    expect(screen.queryByRole('button', { name: 'Silenciar solo para mí' })).not.toBeInTheDocument();
  });
});

describe('SyncedPlayer — calidad', () => {
  it('sin lista de calidades usa el src recibido', () => {
    renderPlayer({ sync: makeSync({ quality: '720p' }) });
    expect(video()).toHaveAttribute('src', SRC);
  });

  it('auto con buena conexión reproduce el original', () => {
    vi.stubGlobal('navigator', { ...navigator, connection: { effectiveType: '4g' } });
    renderPlayer({ qualities: QUALITIES });
    expect(video()).toHaveAttribute('src', SRC);
  });

  it('auto con conexión lenta elige 360p', () => {
    vi.stubGlobal('navigator', { ...navigator, connection: { effectiveType: '3g' } });
    renderPlayer({ qualities: QUALITIES });
    expect(video()).toHaveAttribute('src', QUALITIES[2].url);
  });

  it('cambia el src a la calidad maestra y re-aplica posición y estado al cargar', () => {
    const { rerenderWith, sync } = renderPlayer({ qualities: QUALITIES });
    rerenderWith({ sync: { ...sync, quality: '720p' } });
    expect(video()).toHaveAttribute('src', QUALITIES[1].url);
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(20);
  });

  it('si la calidad pedida no existe cae al original', () => {
    renderPlayer({ qualities: QUALITIES.slice(0, 2), sync: makeSync({ quality: '360p' }) });
    expect(video()).toHaveAttribute('src', SRC);
  });

  it('sin src no muestra vídeo aunque haya calidades', () => {
    renderPlayer({ src: undefined, qualities: QUALITIES });
    expect(screen.queryByLabelText('Vídeo de la sala')).not.toBeInTheDocument();
  });
});
