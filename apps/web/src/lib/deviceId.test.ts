import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_KEY, getDeviceId, resetDeviceIdCache } from './deviceId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  localStorage.clear();
  resetDeviceIdCache();
});

afterEach(() => vi.restoreAllMocks());

describe('getDeviceId', () => {
  it('genera un UUID, lo guarda y lo reutiliza', () => {
    const id = getDeviceId();
    expect(id).toMatch(UUID);
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(id);
    resetDeviceIdCache();
    expect(getDeviceId()).toBe(id);
  });

  it('reemplaza un valor guardado que no es UUID', () => {
    localStorage.setItem(DEVICE_ID_KEY, 'basura');
    const id = getDeviceId();
    expect(id).toMatch(UUID);
    expect(id).not.toBe('basura');
  });

  it('sin localStorage usable sigue funcionando en memoria', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const id = getDeviceId();
    expect(id).toMatch(UUID);
    expect(getDeviceId()).toBe(id);
  });

  it('sin crypto.randomUUID devuelve null', () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('no disponible');
    });
    expect(getDeviceId()).toBeNull();
  });
});
