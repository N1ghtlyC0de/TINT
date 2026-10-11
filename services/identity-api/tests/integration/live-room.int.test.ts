/**
 * Sala en vivo de punta a punta contra la infraestructura real: identity-api
 * (en proceso), sync-core :8083, social-core :8082, PostgreSQL, Redis y MinIO.
 * Solo se simula la verificación del ID token de Firebase.
 *
 * Nació del bug hunting de octubre 2026 (docs/bug-hunting-2026-10.md): cada
 * comprobación anota un hallazgo y la prueba falla si queda alguno.
 * Corre con INTEGRATION=1 (`npm run test:integration`).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';

const state = vi.hoisted(() => ({ userId: '' }));

vi.mock('../../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, res: any, next: any) => {
    const h = req.headers['x-test-user'];
    if (h === 'none') return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: h || state.userId, providerSub: 'it-host', email: 'host@tint.test', displayName: 'Host IT' };
    next();
  },
}));

const RUN = !!process.env.INTEGRATION;
const SYNC = process.env.SYNC_WS_URL ?? 'ws://localhost:8083/ws/sync';
const SOCIAL = process.env.SOCIAL_WS_URL ?? 'ws://localhost:8082/ws/social';
const log: string[] = [];
const note = (s: string) => {
  log.push(s);
};

describe.skipIf(!RUN)('sala en vivo de punta a punta', () => {
  let app: any;
  let redis: any;
  let otherUser = '';

  beforeAll(async () => {
    ({ default: app } = await import('../../src/app.js'));
    const users = await import('../../src/modules/users/users.repo.js');
    state.userId = (await users.upsertByProvider({ providerSub: `hunt-${Date.now()}`, email: 'h@t.c', displayName: 'Host' })).id;
    otherUser = (await users.upsertByProvider({ providerSub: `hunt2-${Date.now()}`, email: 'o@t.c', displayName: 'Otro' })).id;
    ({ getRedisClient: redis } = await import('../../src/modules/tokens/revocation.js'));
  });

  afterAll(async () => {
    const { pool } = await import('../../src/db/client.js');
    await pool.end();
    await (redis() as any).quit?.();
  });

  afterEach(() => {
    const found = log.splice(0);
    expect(found).toEqual([]);
  });

  it('autorización entre salas y roles', async () => {
    const a = (await request(app).post('/api/v1/rooms').send({ title: 'A' })).body;
    const b = (await request(app).post('/api/v1/rooms').set('x-test-user', otherUser).send({ title: 'B' })).body;
    const claimA = await request(app).post('/api/v1/invitations/claim').send({ code: a.invitation.code, nick: 'Ana' });
    const guestA = claimA.body.token;

    // Otro host no puede operar la sala A.
    for (const [m, p] of [
      ['post', `/rooms/${a.room.id}/sync-ticket`],
      ['get', `/rooms/${a.room.id}/guests`],
      ['post', `/rooms/${a.room.id}/media/uploads`],
      ['get', `/rooms/${a.room.id}`],
      ['delete', `/rooms/${a.room.id}`],
    ] as const) {
      const r = await (request(app) as any)[m](`/api/v1${p}`).set('x-test-user', otherUser).send({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 10 });
      if (r.status !== 403) note(`AUTHZ: ${m.toUpperCase()} ${p} por otro host → ${r.status}`);
    }
    // El invitado de A no puede pedir el playback de B.
    const pb = await request(app).get(`/api/v1/rooms/${b.room.id}/playback`).set('Authorization', `Bearer ${guestA}`);
    if (![401, 403].includes(pb.status)) note(`AUTHZ: invitado de A lee playback de B → ${pb.status}`);
    // El token de invitado de A no abre el canal de B.
    const cross = await tryOpen(`${SYNC}?room_id=${b.room.id}&token=${guestA}`);
    if (cross.opened) note('AUTHZ: guest token de A abre /ws/sync de B');
    const crossSocial = await tryOpen(`${SOCIAL}?room_id=${b.room.id}&token=${guestA}`);
    if (crossSocial.opened) note('AUTHZ: guest token de A abre /ws/social de B');
    // Un ID token de Firebase con firma inventada no abre el chat (suplantación).
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const forged = `${b64({ alg: 'RS256', kid: 'x' })}.${b64({ sub: 'victima', name: 'Host Falso', iss: 'https://securetoken.google.com/tint-login', aud: 'tint-login', exp: now + 3600, iat: now })}.firma-falsa`;
    if ((await tryOpen(`${SOCIAL}?room_id=${a.room.id}&token=${forged}`)).opened) note('AUTHZ: token Firebase falsificado abre /ws/social');
    // Claim con espacios / código inexistente / nick vacío.
    const bad = await request(app).post('/api/v1/invitations/claim').send({ code: 'nope', nick: 'x' });
    if (bad.status !== 404) note(`claim código inexistente → ${bad.status}`);
    const empty = await request(app).post('/api/v1/invitations/claim').send({ code: a.invitation.code, nick: '   ' });
    if (empty.status !== 400) note(`claim nick vacío → ${empty.status}`);
    // UUID inválido en rutas de sala.
    const badId = await request(app).get('/api/v1/rooms/no-es-uuid');
    if (badId.status >= 500) note(`GET /rooms/no-es-uuid → ${badId.status}`);
    const badPb = await request(app).get('/api/v1/rooms/no-es-uuid/playback').set('Authorization', `Bearer ${guestA}`);
    if (badPb.status >= 500) note(`GET /rooms/no-es-uuid/playback → ${badPb.status}`);
    const badTicket = await request(app).post('/api/v1/rooms/no-es-uuid/sync-ticket');
    if (badTicket.status >= 500) note(`POST /rooms/no-es-uuid/sync-ticket → ${badTicket.status}`);
  });

  it('sala en vivo: sync, chat, reacciones, revocación y borrado', async () => {
    const created = (await request(app).post('/api/v1/rooms').send({ title: 'Viva' })).body;
    const roomId = created.room.id;
    const g1 = (await request(app).post('/api/v1/invitations/claim').send({ code: created.invitation.code, nick: 'Ana' })).body;
    const g2 = (await request(app).post('/api/v1/invitations/claim').send({ code: created.invitation.code, nick: 'Beto' })).body;
    const ticket = (await request(app).post(`/api/v1/rooms/${roomId}/sync-ticket`)).body.token;

    const host = await open(`${SYNC}?room_id=${roomId}&token=${ticket}`, roomId, true);
    const a = await open(`${SYNC}?room_id=${roomId}&token=${g1.token}`, roomId, true);
    const st = await a.next('STATE');
    if (st.online !== true) note(`sync: invitado ve host online=${st.online} con host conectado`);

    // Comandos básicos y su orden.
    host.send({ type: 'SEEK', position_ms: 30_000 });
    const seek = await a.next('SEEK');
    if (seek.position_ms !== 30_000) note(`sync: SEEK llegó con ${seek.position_ms}`);
    host.send({ type: 'RATE', rate: 1.5, position_ms: 30_000 });
    const rate = await a.next('RATE').catch(() => null);
    if (!rate || rate.rate !== 1.5) note(`sync: RATE no llega bien (${JSON.stringify(rate)})`);
    host.send({ type: 'PLAY', position_ms: 30_000 });
    const play = await a.next('PLAY');
    if (play.status !== 'playing') note(`sync: PLAY status=${play.status}`);
    // Un invitado que se une tarde ve el estado actual.
    const late = await open(`${SYNC}?room_id=${roomId}&token=${g2.token}`, roomId, true);
    const lateSt = await late.next('STATE');
    if (lateSt.status !== 'playing' || lateSt.rate !== 1.5) note(`sync: STATE tardío = ${JSON.stringify(lateSt)}`);

    // Chat y reacciones por social-core (con guest tokens).
    const sa = await open(`${SOCIAL}?room_id=${roomId}&token=${g1.token}`, roomId, false);
    const sb = await open(`${SOCIAL}?room_id=${roomId}&token=${g2.token}`, roomId, false);
    sa.send({ type: 'chat_send', text: 'hola' });
    const chat = await sb.next('chat_message').catch(() => null);
    if (!chat || chat.text !== 'hola' || chat.nick !== 'Ana') note(`social: chat no llega bien (${JSON.stringify(chat)})`);
    sa.send({ type: 'reaction_send', emoji: '😢', position_ms: 31_000 });
    const re = await sb.next('reaction').catch(() => null);
    if (!re || re.emoji !== '😢' || re.position_ms !== 31_000) note(`social: reacción 😢 no llega (${JSON.stringify(re)})`);
    // Reloj del navegador 2 s adelantado: el mensaje igual debe llegar.
    sa.send({ type: 'chat_send', text: 'adelantado', occurred_at: new Date(Date.now() + 2000).toISOString() });
    const skew = await sb.next('chat_message').catch(() => null);
    if (!skew || skew.text !== 'adelantado') note('social: con el reloj adelantado el chat se descarta');
    // Historial para quien entra después.
    const sc = await open(`${SOCIAL}?room_id=${roomId}&token=${g2.token}`, roomId, false);
    const hist = await sc.next('history').catch(() => null);
    if (!hist) note('social: no se envía history al entrar');
    sc.close();

    // Host sin socket: los invitados siguen y reciben HOST_STATUS offline.
    host.close();
    const hs = await a.next('HOST_STATUS', 8000).catch(() => null);
    if (!hs || hs.online !== false) note(`sync: tras cerrar el host no llega HOST_STATUS offline (${JSON.stringify(hs)})`);

    // Revocar a Ana: sync la expulsa con 4001; ¿social-core también?
    const rv = await request(app).post(`/api/v1/rooms/${roomId}/guests/${jti(g1.token)}/revoke`);
    if (rv.status !== 200) note(`revoke → ${rv.status}`);
    const code = await a.closed(5000);
    if (code !== 4001) note(`sync: revocado cerró con ${code}`);
    const again = await tryOpen(`${SYNC}?room_id=${roomId}&token=${g1.token}`);
    if (again.opened) note('sync: revocado puede reconectar');
    const pbRev = await request(app).get(`/api/v1/rooms/${roomId}/playback`).set('Authorization', `Bearer ${g1.token}`);
    if (pbRev.status === 200) note('identity-api: invitado revocado sigue obteniendo playback (URL firmada)');
    const socialClosed = await sa.closed(3000);
    if (socialClosed === null) note('social: el invitado revocado sigue conectado al chat');
    const socialAgain = await tryOpen(`${SOCIAL}?room_id=${roomId}&token=${g1.token}`);
    if (socialAgain.opened) note('social: el invitado revocado puede reconectar al chat');

    // Borrar la sala: ¿se cortan las sesiones vivas y los nuevos accesos?
    const del = await request(app).delete(`/api/v1/rooms/${roomId}`);
    if (del.status !== 200 && del.status !== 204) note(`delete → ${del.status}`);
    const pbDel = await request(app).get(`/api/v1/rooms/${roomId}/playback`).set('Authorization', `Bearer ${g2.token}`);
    // Borrar revoca a los invitados: 401 (token revocado) o 410 (sala borrada).
    if (![401, 410].includes(pbDel.status)) note(`playback tras borrar → ${pbDel.status}`);
    const lateClosed = await late.closed(3000);
    if (lateClosed === null) note('sync: tras borrar la sala los invitados siguen conectados');
    const reopen = await tryOpen(`${SYNC}?room_id=${roomId}&token=${g2.token}`);
    if (reopen.opened) note('sync: tras borrar la sala un invitado puede volver a abrir /ws/sync');
    const sreopen = await tryOpen(`${SOCIAL}?room_id=${roomId}&token=${g2.token}`);
    if (sreopen.opened) note('social: tras borrar la sala un invitado puede volver a abrir el chat');
    const claimDel = await request(app).post('/api/v1/invitations/claim').send({ code: created.invitation.code, nick: 'X' });
    if (claimDel.status !== 410) note(`claim tras borrar → ${claimDel.status}`);
    sb.close();
    late.close();
  }, 60_000);
});

function jti(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).jti;
}

async function tryOpen(url: string): Promise<{ opened: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      resolve({ opened: false });
    }, 3000);
    ws.onopen = () => {
      // Abierto: ver si el servidor lo cierra enseguida (rechazo tardío).
      setTimeout(() => {
        clearTimeout(t);
        const alive = ws.readyState === WebSocket.OPEN;
        ws.close();
        resolve({ opened: alive });
      }, 500);
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve({ opened: false });
    };
  });
}

async function open(url: string, roomId: string, sync: boolean) {
  const ws = new WebSocket(url);
  const inbox: any[] = [];
  let closeCode: number | null = null;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (sync && msg.type === 'HEARTBEAT') {
      ws.send(JSON.stringify({ event_id: crypto.randomUUID(), type: 'SYNC_CHECK', room_id: roomId, position_ms: 0, echo_server_ts: msg.server_time_ms, occurred_at: new Date().toISOString() }));
      return;
    }
    inbox.push(msg);
  };
  ws.onclose = (ev) => {
    closeCode = ev.code;
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`no abre ${url.split('?')[0]}`));
  });
  return {
    send(m: object) {
      ws.send(JSON.stringify({ event_id: crypto.randomUUID(), room_id: roomId, occurred_at: new Date().toISOString(), ...m }));
    },
    async next(type: string, ms = 4000) {
      const end = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() > end) throw new Error(`no llegó ${type}; inbox=${JSON.stringify(inbox.map((m) => m.type))}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async closed(ms: number): Promise<number | null> {
      const end = Date.now() + ms;
      while (closeCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      return closeCode;
    },
    close() {
      ws.close();
    },
  };
}
