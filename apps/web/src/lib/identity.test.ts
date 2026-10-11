import { describe, expect, it, beforeEach } from 'vitest';
import { getLocalIdentity, guestTokenGrantsRoom } from './identity';

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.firma`;
}

describe('getLocalIdentity', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('retorna null sin tokens', () => {
    expect(getLocalIdentity()).toBeNull();
  });

  it('lee nick y sub del guest token', () => {
    localStorage.setItem('tint_guest_token', fakeJwt({ sub: 'guest:1', nick: 'Pedro' }));
    expect(getLocalIdentity()).toEqual({ sub: 'guest:1', nick: 'Pedro', isGuest: true });
  });

  it('prefiere el token de host y deriva nick de name/email', () => {
    localStorage.setItem('tint_guest_token', fakeJwt({ sub: 'guest:1', nick: 'Pedro' }));
    localStorage.setItem(
      'tint_token',
      fakeJwt({ sub: 'host-1', name: 'Drake', email: 'drake@x.com' }),
    );
    expect(getLocalIdentity()).toEqual({ sub: 'host-1', nick: 'Drake', isGuest: false });
  });

  it('usa email y luego Host como fallback', () => {
    localStorage.setItem('tint_token', fakeJwt({ sub: 'host-1', email: 'drake@x.com' }));
    expect(getLocalIdentity()?.nick).toBe('drake@x.com');
    localStorage.setItem('tint_token', fakeJwt({ sub: 'host-1' }));
    expect(getLocalIdentity()?.nick).toBe('Host');
  });

  it('retorna null con tokens corruptos o sin sub', () => {
    localStorage.setItem('tint_guest_token', 'no-es-jwt');
    expect(getLocalIdentity()).toBeNull();
    localStorage.setItem('tint_guest_token', fakeJwt({ nick: 'SinSub' }));
    expect(getLocalIdentity()).toBeNull();
  });
});

describe('guestTokenGrantsRoom', () => {
  const now = 1_700_000_000_000;
  const valid = { sub: 'guest:1', nick: 'Pedro', room_id: 'r1', exp: now / 1000 + 60 };

  it('acepta un token vigente de la misma sala', () => {
    expect(guestTokenGrantsRoom(fakeJwt(valid), 'r1', now)).toBe(true);
  });

  it('rechaza el token de otra sala', () => {
    expect(guestTokenGrantsRoom(fakeJwt(valid), 'r2', now)).toBe(false);
  });

  it('rechaza el token caducado o sin exp', () => {
    expect(guestTokenGrantsRoom(fakeJwt({ ...valid, exp: now / 1000 }), 'r1', now)).toBe(false);
    expect(guestTokenGrantsRoom(fakeJwt({ ...valid, exp: undefined }), 'r1', now)).toBe(false);
  });

  it('rechaza tokens ausentes o corruptos', () => {
    expect(guestTokenGrantsRoom(null, 'r1', now)).toBe(false);
    expect(guestTokenGrantsRoom('no-es-jwt', 'r1', now)).toBe(false);
    expect(guestTokenGrantsRoom(fakeJwt(valid), undefined, now)).toBe(false);
  });

  it('usa el reloj actual por defecto', () => {
    expect(guestTokenGrantsRoom(fakeJwt({ ...valid, exp: Date.now() / 1000 + 60 }), 'r1')).toBe(true);
  });
});
