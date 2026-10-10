import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { beforeEach, vi } from 'vitest';
import WatchRoom from './WatchRoom';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApi = vi.mocked(apiFetch);

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('WatchRoom', () => {
  it('muestra la sala y el rol host si no hay guest token', async () => {
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

  it('tiene un único enlace Volver al dashboard', () => {
    localStorage.setItem('tint_guest_token', 'guest-tok');
    renderWatch();
    const backLinks = screen.getAllByRole('link', { name: 'Volver' });
    expect(backLinks).toHaveLength(1);
    expect(backLinks[0]).toHaveAttribute('href', '/dashboard');
  });

  it('el host ve el titulo real de la sala y el link con copiar', async () => {
    mockedApi.mockImplementation((path: string) => {
      if (path === '/rooms/r1') return Promise.resolve({ room: { id: 'r1', title: 'Noche de cine' } });
      return Promise.resolve({ invitations: [{ code: 'abc123', link: '/invite/abc123' }] });
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderWatch();
    expect(await screen.findByText('Noche de cine')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/invite/abc123`)).toBeInTheDocument();
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
});
