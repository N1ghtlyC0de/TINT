import { act, render, screen, within } from '@testing-library/react';
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

beforeEach(() => mockedApiFetch.mockReset());

describe('ParticipantsPanel — refresco automático', () => {
  afterEach(() => vi.useRealTimers());

  it('re-consulta la lista cada 10 s mientras está montado y para al desmontar', async () => {
    vi.useFakeTimers();
    mockedApiFetch.mockResolvedValueOnce({ guests: [] }).mockResolvedValue({ guests });
    const { unmount } = render(<ParticipantsPanel roomId="r1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Aún no hay invitados en la sala.')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARTICIPANTS_POLL_MS);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('list', { name: 'Invitados' })).toBeInTheDocument();
    // El refresco silencioso no vuelve a mostrar el esqueleto de carga.
    expect(screen.queryByText('Cargando participantes…')).not.toBeInTheDocument();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARTICIPANTS_POLL_MS * 3);
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it('el intervalo por defecto es de ~10 s', () => {
    expect(PARTICIPANTS_POLL_MS).toBe(10_000);
  });
});

describe('ParticipantsPanel', () => {
  it('lista los invitados de la sala con el token de host', async () => {
    mockedApiFetch.mockResolvedValue({ guests });
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
    mockedApiFetch.mockResolvedValue({ guests: [] });
    render(<ParticipantsPanel roomId="r1" />);
    expect(await screen.findByText('Aún no hay invitados en la sala.')).toBeInTheDocument();
  });

  it('respuesta sin lista se trata como vacía', async () => {
    mockedApiFetch.mockResolvedValue({});
    render(<ParticipantsPanel roomId="r1" />);
    expect(await screen.findByText('Aún no hay invitados en la sala.')).toBeInTheDocument();
  });

  it('muestra el error al listar y permite actualizar', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({ guests });
    render(<ParticipantsPanel roomId="r1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo cargar/i);
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar participantes' }));
    expect(await screen.findByRole('list', { name: 'Invitados' })).toBeInTheDocument();
  });

  it('retirar pide confirmación y revoca con POST', async () => {
    mockedApiFetch.mockResolvedValueOnce({ guests }).mockResolvedValueOnce({ success: true });
    render(<ParticipantsPanel roomId="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retirar a Ana' }));
    const confirm = screen.getByRole('button', { name: 'Sí, retirar' });
    expect(confirm).toHaveFocus();
    expect(screen.getByText(/¿Retirar a Ana\?/)).toBeInTheDocument();
    await userEvent.click(confirm);
    expect(mockedApiFetch).toHaveBeenLastCalledWith('/rooms/r1/guests/j1/revoke', { method: 'POST' }, 'host');
    expect(await screen.findAllByText('Retirado')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Retirar a Ana' })).not.toBeInTheDocument();
  });

  it('cancelar no revoca', async () => {
    mockedApiFetch.mockResolvedValueOnce({ guests });
    render(<ParticipantsPanel roomId="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retirar a Ana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Retirar a Ana' })).toHaveFocus();
  });

  it('muestra el error al revocar', async () => {
    mockedApiFetch.mockResolvedValueOnce({ guests }).mockRejectedValueOnce(new ApiError(404, 'jti desconocido'));
    render(<ParticipantsPanel roomId="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retirar a Ana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, retirar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('jti desconocido');
    expect(screen.getByRole('button', { name: 'Retirar a Ana' })).toBeInTheDocument();
  });
});
