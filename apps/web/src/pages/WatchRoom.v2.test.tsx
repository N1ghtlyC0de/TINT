import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { MockXhr } from '../test/mockXhr';
import { apiFetch } from '../lib/api';
import { testGuestToken } from '../test/guestToken';

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

// El chat (/ws/social) se prueba en WatchRoomChat.test.tsx.
vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: () => ({
    status: 'open' as const,
    messages: [],
    reactions: [],
    send: vi.fn(() => true),
    sendReaction: vi.fn(() => true),
  }),
}));

const state = {
  type: 'STATE',
  status: 'paused',
  position_ms: 10_000,
  updated_at_ms: 1_000,
  rate: 1,
  version: 1,
  server_time_ms: 1_000,
  online: true,
  media_id: 'm1',
};

let playbackByCall: Array<{
  mediaId: string | null;
  url: string | null;
  expiresAt: string | null;
  status?: string | null;
  ambilightUrl?: string | null;
}>;

function routeApi(path: string, init?: RequestInit) {
  if (path.endsWith('/sync-ticket')) return Promise.resolve({ token: 'ticket', expiresAt: 'x' });
  if (path.endsWith('/playback')) {
    const next = playbackByCall.length > 1 ? playbackByCall.shift()! : playbackByCall[0];
    return Promise.resolve(next);
  }
  if (path.endsWith('/media') && init?.method === 'PUT') return Promise.resolve({ mediaId: 'm2', mediaKey: 'k' });
  if (path.endsWith('/media/uploads')) {
    return Promise.resolve({
      videoId: 'v9',
      uploadUrl: 'https://minio/tint/v9/source.mp4?sig=1',
      storageKey: 'v9/source.mp4',
      expiresAt: '2099-01-01T00:00:00Z',
      headers: { 'Content-Type': 'video/mp4' },
    });
  }
  if (path.endsWith('/media/uploads/v9/complete')) {
    return Promise.resolve({ mediaId: 'v9', mediaKey: 'v9/source.mp4', status: 'pending' });
  }
  if (path.endsWith('/guests')) {
    return Promise.resolve({
      guests: [{ jti: 'j1', nick: 'Ana', joinedAt: '2026-01-01T10:00:00Z', expiresAt: '2026-01-02T10:00:00Z', revoked: false }],
    });
  }
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
  playbackByCall = [{ mediaId: 'm1', url: 'https://minio/m1?sig=1', expiresAt: '2099-01-01T00:00:00Z' }];
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(routeApi as typeof apiFetch);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('WatchRoom v2 — vídeo de la sala (F3)', () => {
  it('el invitado pide el playback con su guest token y reproduce la URL firmada', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    expect(screen.getByText('Cargando vídeo…')).toBeInTheDocument();
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/playback', { method: 'GET' }, 'guest');
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1?sig=1');
  });

  it('un LOAD con otro media_id vuelve a pedir el playback y cambia el src', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [
      { mediaId: 'm1', url: 'https://minio/m1', expiresAt: null },
      { mediaId: 'm2', url: 'https://minio/m2', expiresAt: null },
    ];
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive(state));
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    act(() => ws.receive({ ...state, type: 'LOAD', event_id: 'e', position_ms: 0, version: 2, media_id: 'm2' }));
    await flush();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m2');
    expect(screen.getByText('El host cargó un nuevo vídeo')).toBeInTheDocument();
  });

  it('si falla el playback muestra el error en el reproductor', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    mockedApiFetch.mockImplementation(((path: string) =>
      path.endsWith('/playback') ? Promise.reject(new Error('401')) : routeApi(path)) as typeof apiFetch);
    renderWatch();
    await flush();
    expect(screen.getByText('No se pudo cargar el vídeo de la sala.')).toBeInTheDocument();
  });
});

describe('WatchRoom v2 — estado del procesamiento (Ambilight)', () => {
  const base = { mediaId: 'm1', url: 'https://minio/m1', expiresAt: null };

  it.each([
    ['pending', 'Procesando vídeo (Ambilight)…'],
    ['processing', 'Procesando vídeo (Ambilight)…'],
    ['ready', 'Ambilight listo'],
    ['failed', 'No se pudo procesar el vídeo; la reproducción sigue disponible'],
  ])('status %s → "%s"', async (status, text) => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [{ ...base, status, ambilightUrl: status === 'ready' ? 'https://a' : null }];
    renderWatch();
    await flush();
    expect(screen.getByRole('status', { name: 'Estado del vídeo' })).toHaveTextContent(text);
    expect(screen.getByLabelText('Vídeo de la sala')).toHaveAttribute('src', 'https://minio/m1');
  });

  it('sin fila de vídeo (status null) no muestra estado de procesamiento', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    playbackByCall = [{ ...base, status: null }];
    renderWatch();
    await flush();
    expect(screen.getByRole('status', { name: 'Estado del vídeo' })).toHaveTextContent('');
  });
});

describe('WatchRoom v2 — host', () => {
  beforeEach(() => localStorage.setItem('tint_token', 'firebase'));

  it('sube un vídeo a MinIO, lo confirma y envía LOAD por el canal', async () => {
    MockXhr.reset();
    vi.stubGlobal('XMLHttpRequest', MockXhr);
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
    await userEvent.upload(
      screen.getByLabelText('Archivo de vídeo'),
      new File(['abc'], 'peli.mp4', { type: 'video/mp4' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
    await waitFor(() => expect(MockXhr.instances).toHaveLength(1));
    act(() => MockXhr.last().respond(200));
    await waitFor(() => expect(ws.sentJson().some((m) => m.type === 'LOAD')).toBe(true));
    expect(ws.sentJson().find((m) => m.type === 'LOAD')).toMatchObject({ media_id: 'v9', position_ms: 0 });
    expect(screen.getByText('Vídeo cargado para todos.')).toBeInTheDocument();
  });

  it('cambia el vídeo por clave: PUT /media y LOAD por el canal', async () => {
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
    await userEvent.click(screen.getByText('Usar un archivo ya subido (clave del bucket)'));
    await userEvent.type(screen.getByLabelText('Clave del objeto en MinIO'), 'pelis/b.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Asignar y cargar' }));
    await waitFor(() => expect(ws.sentJson().some((m) => m.type === 'LOAD')).toBe(true));
    expect(ws.sentJson().find((m) => m.type === 'LOAD')).toMatchObject({ media_id: 'm2', position_ms: 0, room_id: 'r1' });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r1/media',
      { method: 'PUT', body: JSON.stringify({ mediaKey: 'pelis/b.mp4' }) },
      'host',
    );
  });

  it('lista los participantes', async () => {
    renderWatch();
    expect(await screen.findByRole('button', { name: 'Retirar a Ana' })).toBeInTheDocument();
  });

  it('el servidor puede quitarle el control al host', async () => {
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeEnabled();
    act(() => ws.receive({ ...state, can_control: false }));
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeDisabled();
  });
});

describe('WatchRoom v2 — invitado', () => {
  it('con control delegado ve el aviso y puede controlar', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    expect(screen.queryByRole('button', { name: 'Cambiar vídeo' })).not.toBeInTheDocument();
    act(() => ws.receive({ type: 'CONTROL', can_control: true }));
    expect(screen.getByText('El host no está: tienes el control temporal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeEnabled();
    expect(screen.getByText('Controlas la reproducción de la sala')).toBeInTheDocument();
  });

  it('cierre 4001: muestra la expulsión y no reconecta', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.close(4001, 'token revocado'));
    expect(screen.getByRole('alert')).toHaveTextContent('Fuiste retirado de la sala por el host');
    expect(screen.queryByLabelText('Vídeo de la sala')).not.toBeInTheDocument();
    expect(localStorage.getItem('tint_guest_token')).toBeNull();
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/');
  });

  it('avisa de los comandos del host en una región aria-live', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive(state));
    act(() => ws.receive({ ...state, type: 'SEEK', event_id: 'h1', position_ms: 754_000, version: 2 }));
    const toast = screen.getByText('El host saltó a 12:34');
    expect(toast.closest('[aria-live="polite"]')).not.toBeNull();
  });
});

describe('WatchRoom v2 — estado de conexión', () => {
  it('muestra la calidad de sincronía con RTT', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    act(() => ws.receive({ type: 'HEARTBEAT', server_time_ms: 1, rtt_ms: 40 }));
    expect(screen.getByTestId('sync-quality')).toHaveTextContent('Sincronía buena');
  });

  it('muestra el intento de reconexión con cuenta regresiva', async () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    await flush();
    act(() => MockWebSocket.last().close(1006));
    expect(screen.getByTestId('reconnect-countdown')).toHaveTextContent('Reconectando… intento 1');
    expect(screen.queryByTestId('sync-quality')).not.toBeInTheDocument();
  });

  it('los atajos no se disparan al escribir en el chat', async () => {
    localStorage.setItem('tint_token', 'firebase');
    renderWatch();
    await flush();
    const ws = MockWebSocket.last();
    act(() => ws.open());
    const input = screen.getByPlaceholderText('Escribe un mensaje');
    fireEvent.keyDown(input, { key: 'k' });
    expect(ws.sentJson().filter((m) => m.type === 'PLAY')).toHaveLength(0);
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(ws.sentJson().filter((m) => m.type === 'PLAY')).toHaveLength(1);
  });
});
