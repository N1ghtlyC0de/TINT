import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch } from '../lib/api';
import { testGuestToken } from '../test/guestToken';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

// Canal social controlable: cada prueba fija lo que "llega" de social-core.
const social = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../hooks/useSocialSocket', () => ({ useSocialSocket: () => social.current }));

function baseSocial(over: Record<string, unknown> = {}) {
  return {
    status: 'open' as const,
    messages: [],
    reactions: [],
    laser: [],
    send: vi.fn(() => true),
    sendReaction: vi.fn(() => true),
    sendLaser: vi.fn(() => true),
    ...over,
  };
}

function routeApi(path: string) {
  if (path.endsWith('/sync-ticket')) return Promise.resolve({ token: 'ticket', expiresAt: 'x' });
  if (path.endsWith('/playback')) return Promise.resolve({ mediaId: 'm1', url: 'https://minio/m1?sig=1', expiresAt: null });
  return Promise.reject(new Error(`ruta no simulada ${path}`));
}

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  vi.stubEnv('VITE_SYNC_ENCODING', 'json');
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(routeApi as typeof apiFetch);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  social.current = baseSocial();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('WatchRoom — puntero láser', () => {
  it('el host activa el láser y dibuja sobre el vídeo', async () => {
    localStorage.setItem('tint_token', 'host-token');
    renderWatch();
    await flush();
    const toggle = screen.getByRole('button', { name: 'Puntero láser' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const surface = screen.getByTestId('laser-overlay');
    expect(surface.className).toContain('pointer-events-none');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(surface.className).toContain('cursor-crosshair');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(surface, { clientX: 25, clientY: 50 });
    expect(social.current.sendLaser).toHaveBeenCalledWith(0.25, 0.5, false);
  });

  it('el invitado ve el trazo pero no tiene el botón del láser', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    expect(screen.queryByRole('button', { name: 'Puntero láser' })).not.toBeInTheDocument();
    expect(screen.getByTestId('laser-overlay').className).toContain('pointer-events-none');
  });
});
