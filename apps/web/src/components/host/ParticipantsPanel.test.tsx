import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from '../../lib/api';
import { PARTICIPANTS_POLL_MS, ParticipantsPanel } from './ParticipantsPanel';

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

const guests = [
  { jti: 'j1', nick: 'Ana', joinedAt: '2026-01-01T10:00:00.000Z', expiresAt: '2026-01-02T10:00:00.000Z', revoked: false },
  { jti: 'j2', nick: 'Beto', joinedAt: '2026-01-01T10:05:00.000Z', expiresAt: '2026-01-02T10:05:00.000Z', revoked: true },
];

type Handler = (init?: RequestInit) => Promise<unknown>;

/** Rutas de identity-api: invitados, bloqueos y acciones; lo no simulado falla. */
function route(handlers: { guests?: Handler; bans?: Handler; revoke?: Handler; ban?: Handler; unban?: Handler } = {}) {
  mockedApiFetch.mockImplementation(((path: string, init?: RequestInit) => {
    if (path.endsWith('/guests')) return handlers.guests?.(init) ?? Promise.resolve({ guests });
    if (path.endsWith('/revoke')) return handlers.revoke?.(init) ?? Promise.resolve({ success: true });
    if (path.endsWith('/bans') && init?.method === 'GET') return handlers.bans?.(init) ?? Promise.resolve({ bans: [] });
    if (path.endsWith('/bans') && init?.method === 'POST') {
      return handlers.ban?.(init) ?? Promise.resolve({ ban: { id: 'b9', nick: 'Ana', createdAt: '2026-01-01T11:00:00.000Z' } });
    }
    if (path.includes('/bans/') && init?.method === 'DELETE') return handlers.unban?.(init) ?? Promise.resolve({ success: true });
    return Promise.reject(new Error(`ruta no simulada ${path}`));
  }) as typeof apiFetch);
}

const guestCalls = () => mockedApiFetch.mock.calls.filter(([p]) => String(p).endsWith('/guests'));

beforeEach(() => {
  mockedApiFetch.mockReset();
  route();
});

describe('ParticipantsPanel — refresco automático', () => {
  afterEach(() => vi.useRealTimers());

  it('re-consulta la lista cada 10 s mientras está montado y para al desmontar', async () => {
    vi.useFakeTimers();
    let first = true;
    route({
      guests: () => {
        const res = first ? { guests: [] } : { guests };
        first = false;
        return Promise.resolve(res);
      },
    });
    const { unmount } = render(<ParticipantsPanel roomId="r1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Aún no hay invitados en la sala.')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARTICIPANTS_POLL_MS);
    });
    expect(guestCalls()).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Invitados' })).toBeInTheDocument();
    // El refresco silencioso no vuelve a mostrar el esqueleto de carga.
    expect(screen.queryByText('Cargando participantes…')).not.toBeInTheDocument();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARTICIPANTS_POLL_MS * 3);
    });
    expect(guestCalls()).toHaveLength(2);
  });

  it('el intervalo por defecto es de ~10 s', () => {
    expect(PARTICIPANTS_POLL_MS).toBe(10_000);
  });
});

describe('ParticipantsPanel', () => {
  it('lista los invitados de la sala con el token de host', async () => {
    render(<ParticipantsPanel roomId="r 1" />);
    expect(screen.getByText('Cargando participantes…')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Invitados' });
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r%201/guests', { method: 'GET' }, 'host');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Retirar a Ana' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retirar a Beto' })).not.toBeInTheDocument();
    expect(screen.getByText('Retirado')).toBeInTheDocument();
  });

  it('estado vacío', async () => {
    route({ guests: () => Promise.resolve({ guests: [] }) });
    render(<ParticipantsPanel roomId="r1" />);
    expect(await screen.findByText('Aún no hay invitados en la sala.')).toBeInTheDocument();
  });

  it('respuesta sin lista se trata como vacía', async () => {
    route({ guests: () => Promise.resolve({}) });
    render(<ParticipantsPanel roomId="r1" />);
    expect(await screen.findByText('Aún no hay invitados en la sala.')).toBeInTheDocument();
  });

  it('muestra el error al listar y permite actualizar', async () => {
    let fail = true;
    route({
      guests: () => {
        const r = fail ? Promise.reject(new Error('x')) : Promise.resolve({ guests });
        fail = false;
        return r;
      },
    });
    render(<ParticipantsPanel roomId="r1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo cargar/i);
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar participantes' }));
    expect(await screen.findByRole('list', { name: 'Invitados' })).toBeInTheDocument();
  });

  it('retirar pide confirmación y revoca con POST', async () => {
    render(<ParticipantsPanel roomId="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retirar a Ana' }));
    const confirm = screen.getByRole('button', { name: 'Sí, retirar' });
    expect(confirm).toHaveFocus();
    expect(screen.getByText(/¿Retirar a Ana\?/)).toBeInTheDocument();
    await userEvent.click(confirm);
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/guests/j1/revoke', { method: 'POST' }, 'host');
    expect(await screen.findAllByText('Retirado')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Retirar a Ana' })).not.toBeInTheDocument();
  });

  it('cancelar no revoca', async () => {
    render(<ParticipantsPanel roomId="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retirar a Ana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(mockedApiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/revoke'), expect.anything(), 'host');
    expect(screen.getByRole('button', { name: 'Retirar a Ana' })).toHaveFocus();
  });

  it('muestra el error al revocar', async () => {
    route({ revoke: () => Promise.reject(new ApiError(404, 'jti desconocido')) });
    render(<ParticipantsPanel roomId="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retirar a Ana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, retirar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('jti desconocido');
    expect(screen.getByRole('button', { name: 'Retirar a Ana' })).toBeInTheDocument();
  });
});

describe('ParticipantsPanel — bloqueos', () => {
  const bans = [{ id: 'b1', nick: 'Carla', createdAt: '2026-01-01T09:00:00.000Z' }];

  it('bloquear pide confirmación, llama a POST bans {jti} y lo pasa a "Bloqueados"', async () => {
    render(<ParticipantsPanel roomId="r1" />);
    expect(await screen.findByText('Nadie está bloqueado.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Bloquear a Ana' }));
    expect(screen.getByText(/¿Bloquear a Ana\?/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Sí, bloquear' });
    expect(confirm).toHaveFocus();
    await userEvent.click(confirm);
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/bans', { method: 'POST', body: JSON.stringify({ jti: 'j1' }) }, 'host');
    const blocked = await screen.findByRole('list', { name: 'Bloqueados' });
    expect(within(blocked).getByText('Ana')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bloquear a Ana' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Retirado')).toHaveLength(2);
  });

  it('un bloqueo fallido se explica con palabras simples', async () => {
    route({ ban: () => Promise.reject(new ApiError(503, 'Service unavailable')) });
    render(<ParticipantsPanel roomId="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bloquear a Ana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, bloquear' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no está disponible');
  });

  it('lista los bloqueados y los desbloquea', async () => {
    route({ bans: () => Promise.resolve({ bans }) });
    render(<ParticipantsPanel roomId="r1" />);
    const list = await screen.findByRole('list', { name: 'Bloqueados' });
    expect(within(list).getByText('Carla')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Desbloquear a Carla' }));
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/bans/b1', { method: 'DELETE' }, 'host');
    expect(await screen.findByText('Nadie está bloqueado.')).toBeInTheDocument();
  });

  it('si no se puede desbloquear lo avisa', async () => {
    route({ bans: () => Promise.resolve({ bans }), unban: () => Promise.reject(new Error('x')) });
    render(<ParticipantsPanel roomId="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Desbloquear a Carla' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo desbloquear a Carla.');
  });

  it('si la lista de bloqueados falla, los invitados siguen visibles', async () => {
    route({ bans: () => Promise.reject(new Error('x')) });
    render(<ParticipantsPanel roomId="r1" />);
    expect(await screen.findByRole('list', { name: 'Invitados' })).toBeInTheDocument();
    expect(await screen.findByText('No se pudo cargar la lista de bloqueados.')).toBeInTheDocument();
  });
});

describe('ParticipantsPanel — salida animada', () => {
  it('un invitado que desaparece de la lista sale (fade + colapso) y se desmonta', async () => {
    let calls = 0;
    route({ guests: () => Promise.resolve(calls++ === 0 ? { guests } : { guests: [guests[0]] }) });
    render(<ParticipantsPanel roomId="r1" />);
    const list = await screen.findByRole('list', { name: 'Invitados' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByRole('listitem')[0].className).toContain('overflow-hidden');
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar participantes' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(within(list).queryByText('Beto')).not.toBeInTheDocument();
  });
});
