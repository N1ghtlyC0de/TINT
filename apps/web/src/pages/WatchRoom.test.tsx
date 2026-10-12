import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { beforeEach, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { MockWebSocket } from '../test/mockWebSocket';
import { apiFetch } from '../lib/api';
import { testGuestToken } from '../test/guestToken';

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

function guestJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.firma`;
}

function hostJwt(payload: Record<string, unknown>): string {
  return guestJwt(payload);
}

beforeEach(() => {
  // El Canal Sync (/ws/sync) se prueba en WatchRoom.sync.test.tsx: aquí no abre sockets reales.
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.clearAllMocks();
  localStorage.clear();
});

describe('WatchRoom', () => {
  it('muestra la sala y el rol host con sesión de host', async () => {
    localStorage.setItem('tint_token', hostJwt({ sub: 'host-1', name: 'Drake' }));
    mockedApi.mockRejectedValue(new Error('offline'));
    renderWatch();
    expect(await screen.findByText(/Sala r1/)).toBeInTheDocument();
    expect(screen.getByTitle(/conectado como drake/i).textContent).toMatch(/host/);
  });

  it('muestra nick y rol de participante en un solo chip', () => {
    localStorage.setItem('tint_guest_token', testGuestToken({ sub: 'guest:u9', nick: 'Pedro' }));
    renderWatch();
    const chip = screen.getByTitle(/conectado como pedro/i);
    expect(chip.textContent).toMatch(/pedro/i);
    expect(chip.textContent).toMatch(/participante/i);
  });

  it('el host manda aunque haya restos de invitado: pide el título fresco', async () => {
    localStorage.setItem('tint_token', hostJwt({ sub: 'host-1', name: 'Drake' }));
    localStorage.setItem('tint_guest_token', testGuestToken());
    localStorage.setItem('tint_room_title', 'Sala vieja');
    mockedApi.mockImplementation((path: string) => {
      if (path === '/rooms/r1') return Promise.resolve({ room: { id: 'r1', title: 'Testing' } });
      return Promise.resolve({ invitations: [] });
    });
    renderWatch();
    expect(await screen.findByText('Testing')).toBeInTheDocument();
    expect(screen.getByTitle(/conectado como drake/i).textContent).toMatch(/host/);
    expect(screen.queryByText('Sala vieja')).not.toBeInTheDocument();
  });

  it('el host tiene un único enlace Volver al dashboard', () => {
    localStorage.setItem('tint_token', 'host-tok');
    mockedApi.mockRejectedValue(new Error('offline'));
    renderWatch();
    const backLinks = screen.getAllByRole('link', { name: 'Volver' });
    expect(backLinks).toHaveLength(1);
    expect(backLinks[0]).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'TINT inicio' })).toHaveAttribute('href', '/dashboard');
  });

  it('el invitado vuelve al inicio, no al dashboard (que exige sesión de host)', () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    expect(screen.getByRole('link', { name: 'Volver' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'TINT inicio' })).toHaveAttribute('href', '/');
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
    localStorage.setItem('tint_guest_token', testGuestToken());
    localStorage.setItem('tint_room_title', 'Noche de cine');
    localStorage.setItem('tint_invite_link', '/invite/abc123');
    renderWatch();
    expect(screen.getByText('Noche de cine')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/invite/abc123`)).toBeInTheDocument();
    // Solo pide la URL de reproducción (permitida con guest token), nunca datos de host.
    expect(mockedApi).not.toHaveBeenCalledWith('/rooms/r1');
    expect(mockedApi).not.toHaveBeenCalledWith('/rooms/r1/invitations');
  });

  it('muestra el logo TINT antes del enlace Volver', () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    renderWatch();
    const logo = screen.getByRole('link', { name: 'TINT inicio' });
    const volver = screen.getByRole('link', { name: 'Volver' });
    expect(logo.compareDocumentPosition(volver)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('fusiona nick y rol en un solo chip de persona', () => {
    localStorage.setItem('tint_guest_token', testGuestToken({ sub: 'guest:u9', nick: 'Pedro' }));
    localStorage.setItem('tint_room_title', 'Noche de cine');
    renderWatch();
    const chip = screen.getByTitle(/conectado como pedro/i);
    expect(chip.textContent).toMatch(/pedro/i);
    expect(chip.textContent).toMatch(/participante/i);
    expect(screen.queryByText(/rol:/i)).not.toBeInTheDocument();
    expect(chip.querySelector('svg')).not.toBeNull();
  });

  it('sin ningún token muestra la puerta y no intenta nada (ni socket ni api)', () => {
    MockWebSocket.reset();
    renderWatch();
    expect(screen.getByText(/únete a esta sala/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Escribe un mensaje')).not.toBeInTheDocument();
    expect(createSocketSpy).not.toHaveBeenCalled();
    // Ni sync-ticket/playback (identity-api) ni /ws/sync.
    expect(mockedApi).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('con el guest token de otra sala muestra la puerta, sin socket ni título ajeno', () => {
    MockWebSocket.reset();
    localStorage.setItem('tint_guest_token', testGuestToken({ room_id: 'otra' }));
    localStorage.setItem('tint_room_title', 'Sala de otra invitación');
    renderWatch();
    expect(screen.getByText(/únete a esta sala/i)).toBeInTheDocument();
    expect(screen.queryByText('Sala de otra invitación')).not.toBeInTheDocument();
    expect(createSocketSpy).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(mockedApi).not.toHaveBeenCalled();
    // El token sigue sirviendo para su propia sala: no se borra.
    expect(localStorage.getItem('tint_guest_token')).not.toBeNull();
  });

  it('con el guest token caducado muestra la puerta en vez de reconectar sin fin', () => {
    MockWebSocket.reset();
    localStorage.setItem('tint_guest_token', testGuestToken({ exp: Math.floor(Date.now() / 1000) - 10 }));
    renderWatch();
    expect(screen.getByText(/únete a esta sala/i)).toBeInTheDocument();
    expect(MockWebSocket.instances).toHaveLength(0);
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

  describe('cabecera móvil: popover Invitar', () => {
    function setupGuest() {
      localStorage.setItem('tint_guest_token', testGuestToken({ sub: 'guest:u9', nick: 'Pedro' }));
      localStorage.setItem('tint_invite_link', '/invite/abc123');
      renderWatch();
      return screen.getByRole('button', { name: 'Invitar' });
    }

    const panelOf = (trigger: HTMLElement) => document.getElementById(trigger.getAttribute('aria-controls') ?? '');

    it('abre un panel con la identidad y el link de invitación', async () => {
      const trigger = setupGuest();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger.className).toContain('sm:hidden');
      expect(panelOf(trigger)).toBeNull();
      await userEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      const panel = panelOf(trigger);
      expect(panel).not.toBeNull();
      expect(panel?.className).toContain('tint-glass-panel');
      const scope = within(panel as HTMLElement);
      expect(scope.getByText(/Pedro · participante/)).toBeInTheDocument();
      expect(scope.getByText(`${window.location.origin}/invite/abc123`)).toBeInTheDocument();
      expect(scope.getByRole('button', { name: 'Copiar' })).toBeInTheDocument();
    });

    it('se cierra con Escape y devuelve el foco al botón', async () => {
      const trigger = setupGuest();
      await userEvent.click(trigger);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await waitFor(() => expect(panelOf(trigger)).toBeNull());
      expect(trigger).toHaveFocus();
    });

    it('se cierra con un clic fuera y no con uno dentro', async () => {
      const trigger = setupGuest();
      await userEvent.click(trigger);
      fireEvent.pointerDown(panelOf(trigger) as HTMLElement);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      fireEvent.pointerDown(document.body);
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('el botón alterna el panel', async () => {
      const trigger = setupGuest();
      await userEvent.click(trigger);
      await userEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('sin identidad ni link no hay botón Invitar', () => {
      localStorage.setItem('tint_token', 'host-tok');
      mockedApi.mockRejectedValue(new Error('offline'));
      renderWatch();
      expect(screen.queryByRole('button', { name: 'Invitar' })).not.toBeInTheDocument();
    });
  });

  it('la sala lleva el fondo ambiental en una raíz aislada', () => {
    localStorage.setItem('tint_guest_token', testGuestToken());
    const { container } = renderWatch();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('isolate');
    expect(root.querySelector('[data-orb]')).not.toBeNull();
  });

  it('la puerta también lleva el fondo ambiental', () => {
    const { container } = renderWatch();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('isolate');
    expect(root.querySelector('[data-orb]')).not.toBeNull();
  });
});
