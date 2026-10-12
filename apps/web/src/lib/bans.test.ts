import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './api';
import { banErrorMessage, banGuest, listBans, unbanGuest } from './bans';

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

beforeEach(() => mockedApiFetch.mockReset());

describe('bans', () => {
  it('banGuest envía {sub} o {jti} y devuelve el ban', async () => {
    const ban = { id: 'b1', nick: 'Ana', createdAt: '2026-10-11T10:00:00Z' };
    mockedApiFetch.mockResolvedValue({ ban });
    await expect(banGuest('r 1', { sub: 'guest:ana' })).resolves.toEqual(ban);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r%201/bans',
      { method: 'POST', body: JSON.stringify({ sub: 'guest:ana' }) },
      'host',
    );
    await banGuest('r1', { jti: 'j1' });
    expect(mockedApiFetch).toHaveBeenLastCalledWith('/rooms/r1/bans', { method: 'POST', body: JSON.stringify({ jti: 'j1' }) }, 'host');
  });

  it('listBans tolera respuestas sin lista', async () => {
    mockedApiFetch.mockResolvedValueOnce({ bans: [{ id: 'b1', nick: 'Ana', createdAt: 'x' }] }).mockResolvedValueOnce({});
    await expect(listBans('r1')).resolves.toHaveLength(1);
    await expect(listBans('r1')).resolves.toEqual([]);
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/bans', { method: 'GET' }, 'host');
  });

  it('unbanGuest borra el ban', async () => {
    mockedApiFetch.mockResolvedValue({ success: true });
    await unbanGuest('r1', 'b 1');
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/bans/b%201', { method: 'DELETE' }, 'host');
  });

  it.each([
    [new ApiError(404, 'x'), /ya no está en la sala/],
    [new ApiError(503, 'x'), /no está disponible/],
    [new ApiError(403, 'x'), /permiso/],
    [new ApiError(500, 'x'), /No se pudo bloquear a Ana/],
    [new TypeError('red'), /No se pudo bloquear a Ana/],
  ])('mensaje simple %#', (err, expected) => {
    expect(banErrorMessage(err, 'Ana')).toMatch(expected);
  });
});
