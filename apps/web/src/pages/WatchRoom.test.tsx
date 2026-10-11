import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { beforeEach, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApi = vi.mocked(apiFetch);

const createSocketSpy = vi.fn();

vi.mock('../hooks/useSocialSocket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useSocialSocket')>();
  return {
    ...actual,
    useSocialSocket: (roomId: string | undefined, opts: Record<string, unknown> = {}) =>
      (
        actual as unknown as {
          useSocialSocket: (r: string | undefined, o: Record<string, unknown>) => unknown;
        }
      ).useSocialSocket(roomId, {
        ...opts,
        createSocket: (url: string) => {
          createSocketSpy(url);
          return { readyState: 0, close() {}, send() {} } as unknown as WebSocket;
        },
      }),
  };
});

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
        <Route path="/invite/:code" element={<p>Invitación OK</p>} />
        <Route path="/login" element={<p>Login OK</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('WatchRoom', () => {
  it('muestra la sala y el rol host con sesión de host', async () => {
    localStorage.setItem('tint_token', 'host-tok');
    mockedApi.mockRejectedValue(new Error('offline'));
    renderWatch();
    expect(await screen.findByText(/Sala r1/)).toBeInTheDocument();
    expect(screen.getByText(/host \(registrado\)/)).toBeInTheDocument();
  });

  it('muestra el rol participante si hay guest token', () => {
    localStorage.setItem('tint_guest_token', 'guest-tok');
    renderWatch();
    expect(screen.getByText(/participante \(invitado\)/)).toBeInTheDocument();
  });

  it('el host manda aunque haya restos de invitado: pide el título fresco', async () => {
    localStorage.setItem('tint_token', 'host-tok');
    localStorage.setItem('tint_guest_token', 'guest-viejo');
    localStorage.setItem('tint_room_title', 'Sala vieja');
    mockedApi.mockImplementation((path: string) => {
      if (path === '/rooms/r1') return Promise.resolve({ room: { id: 'r1', title: 'Testing' } });
      return Promise.resolve({ invitations: [] });
    });
    renderWatch();
    expect(await screen.findByText('Testing')).toBeInTheDocument();
    expect(screen.getByText(/host \(registrado\)/)).toBeInTheDocument();
    expect(screen.queryByText('Sala vieja')).not.toBeInTheDocument();
  });

  it('tiene un único enlace Volver al dashboard', () => {
    localStorage.setItem('tint_guest_token', 'guest-tok');
    renderWatch();
    const backLinks = screen.getAllByRole('link', { name: 'Volver' });
    expect(backLinks).toHaveLength(1);
    expect(backLinks[0]).toHaveAttribute('href', '/dashboard');
  });

  it('el host ve el titulo real de la sala y el link con copiar', async () => {
    localStorage.setItem('tint_token', 'host-tok');
    mockedApi.mockImplementation((path: string) => {
      if (path === '/rooms/r1') return Promise.resolve({ room: { id: 'r1', title: 'Noche de cine' } });
      return Promise.resolve({
        invitations: [
          { code: 'abc123', link: '/invite/abc123', expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
        ],
      });
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderWatch();
    expect(await screen.findByText('Noche de cine')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/invite/abc123`)).toBeInTheDocument();
  });

  it('el host ve el link vigente más reciente aunque haya varios', async () => {
    localStorage.setItem('tint_token', 'host-tok');
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockedApi.mockImplementation((path: string) => {
      if (path === '/rooms/r1') return Promise.resolve({ room: { id: 'r1', title: 'Noche de cine' } });
      return Promise.resolve({
        invitations: [
          { code: 'vieja11', link: '/invite/vieja11', expiresAt: future, createdAt: '2026-10-09T12:00:00.000Z' },
          { code: 'nueva22', link: '/invite/nueva22', expiresAt: future, createdAt: '2026-10-10T12:00:00.000Z' },
          { code: 'revocada', link: '/invite/revocada', expiresAt: future, createdAt: '2026-10-10T13:00:00.000Z', revoked: true },
        ],
      });
    });
    renderWatch();
    expect(await screen.findByText('Noche de cine')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/invite/nueva22`)).toBeInTheDocument();
    expect(screen.queryByText(`${window.location.origin}/invite/vieja11`)).not.toBeInTheDocument();
  });

  it('el invitado ve el titulo y el link guardados al canjear', () => {
    localStorage.setItem('tint_guest_token', 'guest-tok');
    localStorage.setItem('tint_room_title', 'Noche de cine');
    localStorage.setItem('tint_invite_link', '/invite/abc123');
    renderWatch();
    expect(screen.getByText('Noche de cine')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/invite/abc123`)).toBeInTheDocument();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('muestra el logo TINT antes del enlace Volver', () => {
    localStorage.setItem('tint_guest_token', 'guest-tok');
    renderWatch();
    const logo = screen.getByRole('link', { name: 'TINT inicio' });
    expect(logo).toHaveAttribute('href', '/dashboard');
    const volver = screen.getByRole('link', { name: 'Volver' });
    expect(logo.compareDocumentPosition(volver)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('sin ningún token muestra la puerta y no intenta nada (ni socket ni api)', () => {
    renderWatch();
    expect(screen.getByText(/únete a esta sala/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Escribe un mensaje')).not.toBeInTheDocument();
    expect(createSocketSpy).not.toHaveBeenCalled();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('la puerta lleva a la invitación con un link válido', async () => {
    renderWatch();
    await userEvent.type(screen.getByPlaceholderText(/link o el código/i), 'http://localhost:5173/invite/abc123XYZ');
    await userEvent.click(screen.getByText('Continuar'));
    expect(await screen.findByText('Invitación OK')).toBeInTheDocument();
  });

  it('la puerta avisa si el link no es válido', async () => {
    renderWatch();
    await userEvent.type(screen.getByPlaceholderText(/link o el código/i), 'hola');
    await userEvent.click(screen.getByText('Continuar'));
    expect(await screen.findByText(/no parece válido/i)).toBeInTheDocument();
    expect(screen.queryByText('Invitación OK')).not.toBeInTheDocument();
  });

  it('la puerta enlaza al login con retorno a la sala', () => {
    renderWatch();
    expect(screen.getByRole('link', { name: /Inicia sesión/i })).toHaveAttribute(
      'href',
      '/login?next=%2Fwatch%2Fr1',
    );
  });
});
