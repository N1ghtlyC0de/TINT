import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

// El chat (/ws/social) se prueba en WatchRoomChat.test.tsx.
vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: () => ({ status: 'open' as const, messages: [], send: vi.fn(() => true) }),
}));

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
  });
}

beforeEach(() => {
  localStorage.clear();
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  mockedApiFetch.mockReset();
  mockedApiFetch.mockResolvedValue({ token: 'ticket', expiresAt: 'x' });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('WatchRoom', () => {
  it('muestra la sala y el rol host si no hay guest token', async () => {
    renderWatch();
    await flush();
    expect(screen.getByText(/Sala r1/)).toBeInTheDocument();
    expect(screen.getByText(/host \(registrado\)/)).toBeInTheDocument();
  });

  it('muestra el rol participante si hay guest token', () => {
    localStorage.setItem('tint_guest_token', 'guest-tok');
    renderWatch();
    expect(screen.getByText(/participante \(invitado\)/)).toBeInTheDocument();
  });

  it('el token de host tiene prioridad sobre un guest token previo', async () => {
    localStorage.setItem('tint_token', 'firebase');
    localStorage.setItem('tint_guest_token', 'guest-tok');
    renderWatch();
    await flush();
    expect(screen.getByText(/host \(registrado\)/)).toBeInTheDocument();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/sync-ticket', { method: 'POST' });
  });

  it('guest se conecta a /ws/sync con su token y no puede controlar', () => {
    localStorage.setItem('tint_guest_token', 'guest-tok');
    renderWatch();
    expect(MockWebSocket.last().url).toContain('room_id=r1&token=guest-tok');
    act(() => MockWebSocket.last().open());
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeDisabled();
    expect(mockedApiFetch).not.toHaveBeenCalledWith('/rooms/r1/sync-ticket', expect.anything());
  });

  it('host obtiene un ticket, conecta y habilita los controles', async () => {
    renderWatch();
    await flush();
    expect(MockWebSocket.last().url).toContain('token=ticket');
    expect(screen.getByText('Conectando…')).toBeInTheDocument();
    act(() => MockWebSocket.last().open());
    expect(screen.getByText('Sincronizado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeEnabled();
  });

  it('sin VITE_DEMO_VIDEO_URL muestra el aviso', async () => {
    vi.stubEnv('VITE_DEMO_VIDEO_URL', '');
    localStorage.setItem('tint_guest_token', 'g');
    renderWatch();
    await flush();
    expect(screen.getByText('Sin video configurado')).toBeInTheDocument();
  });

  it('con VITE_DEMO_VIDEO_URL (sala sin vídeo) reproduce el respaldo y responde heartbeats', async () => {
    vi.stubEnv('VITE_DEMO_VIDEO_URL', 'https://cdn.test/demo.mp4');
    localStorage.setItem('tint_guest_token', 'g');
    renderWatch();
    await flush();
    const video = screen.getByLabelText('Vídeo de la sala') as HTMLVideoElement;
    expect(video).toHaveAttribute('src', 'https://cdn.test/demo.mp4');
    const ws = MockWebSocket.last();
    act(() => ws.open());
    video.currentTime = 7;
    fireEvent.timeUpdate(video);
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 123 }));
    expect(ws.sentJson()[0]).toMatchObject({ type: 'SYNC_CHECK', position_ms: 7_000, echo_server_ts: 123 });
  });
});
