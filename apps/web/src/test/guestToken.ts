/**
 * Guest token de prueba con forma de JWT (firma falsa): por defecto de la sala `r1` y
 * vigente una hora, como los que emite identity-api al canjear una invitación.
 */
export function testGuestToken(payload: Record<string, unknown> = {}): string {
  const b64 = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const claims = {
    sub: 'guest:test',
    nick: 'Invitado',
    room_id: 'r1',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  };
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.firma`;
}
