/**
 * Flujo completo de punta a punta contra la infraestructura real
 * (docker compose: PostgreSQL, Redis, MinIO y sync-core):
 *
 *   crear sala → invitar → subir vídeo directo a MinIO → confirmar
 *   (XADD media:uploads) → [media-worker: ready + ambilight.json]
 *   → URL firmada de reproducción → LOAD/PLAY en vivo por el Canal Sync.
 *
 * Solo corre con INTEGRATION=1 (`npm run test:integration`). Solo se simula la
 * verificación del ID token de Firebase; todo lo demás es real.
 * Con WAIT_WORKER=1 espera además a que media-worker deje el vídeo en `ready`.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ userId: '' }));

vi.mock('../../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: state.userId, providerSub: 'it-host', email: 'host@tint.test', displayName: 'Host IT' };
    next();
  },
}));

const RUN = !!process.env.INTEGRATION;
const SYNC_WS_URL = process.env.SYNC_WS_URL ?? 'ws://localhost:8083/ws/sync';
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

describe.skipIf(!RUN)('flujo completo: subida, reproducción y sala en vivo', () => {
  let app: any;
  let redis: any;
  let video: Buffer;

  beforeAll(async () => {
    ({ default: app } = await import('../../src/app.js'));
    const users = await import('../../src/modules/users/users.repo.js');
    const user = await users.upsertByProvider({ providerSub: `it-${Date.now()}`, email: 'host@tint.test', displayName: 'Host IT' });
    state.userId = user.id;
    ({ getRedisClient: redis } = await import('../../src/modules/tokens/revocation.js'));
    // Vídeo real de 3 s generado con ffmpeg (el worker lo inspecciona con ffprobe).
    const dir = mkdtempSync(join(tmpdir(), 'tint-it-'));
    const file = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=10', '-pix_fmt', 'yuv420p', file]);
    video = readFileSync(file);
  });

  afterAll(async () => {
    const { pool } = await import('../../src/db/client.js');
    await pool.end();
    await (redis() as any).quit?.();
  });

  it('recorre todo el flujo con los servicios reales', async () => {
    // 1. El host crea la sala (con su invitación inicial).
    const created = await request(app).post('/api/v1/rooms').send({ title: 'Noche de integración' });
    expect(created.status).toBe(200);
    const roomId: string = created.body.room.id;
    const code: string = created.body.invitation.code;

    // 2. Pide la URL de subida y el navegador sube directo a MinIO (con CORS).
    const start = await request(app)
      .post(`/api/v1/rooms/${roomId}/media/uploads`)
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', sizeBytes: video.length });
    expect(start.status).toBe(200);
    const { videoId, uploadUrl, headers } = start.body;

    const preflight = await fetch(uploadUrl, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toMatch(new RegExp(`^(\\*|${ORIGIN})$`));

    // Antes de subir, confirmar falla: el objeto no está en el bucket.
    expect((await request(app).post(`/api/v1/rooms/${roomId}/media/uploads/${videoId}/complete`)).status).toBe(409);

    const put = await fetch(uploadUrl, { method: 'PUT', headers: { ...headers, Origin: ORIGIN }, body: video });
    expect(put.status).toBe(200);

    // 3. Confirma: encola el procesamiento y asigna el vídeo a la sala.
    const done = await request(app).post(`/api/v1/rooms/${roomId}/media/uploads/${videoId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.mediaId).toBe(videoId);
    const events = await redis().xrange('media:uploads', '-', '+');
    expect(events.some(([, fields]: [string, string[]]) => fields[1] === videoId)).toBe(true);

    // 4. Un amigo entra con la invitación y obtiene la URL firmada del vídeo.
    const claim = await request(app).post('/api/v1/invitations/claim').send({ code, nick: 'Amiga' });
    expect(claim.status).toBe(200);
    const guestToken: string = claim.body.token;
    const playback = await request(app).get(`/api/v1/rooms/${roomId}/playback`).set('Authorization', `Bearer ${guestToken}`);
    expect(playback.status).toBe(200);
    expect(playback.body.mediaId).toBe(videoId);
    const blob = await fetch(playback.body.url, { headers: { Origin: ORIGIN } });
    expect(blob.status).toBe(200);
    expect(Buffer.from(await blob.arrayBuffer()).equals(video)).toBe(true);

    // 5. (opcional) media-worker procesa el vídeo: ready + ambilight.json.
    if (process.env.WAIT_WORKER) {
      let body = playback.body;
      for (let i = 0; i < 60 && body.status !== 'ready' && body.status !== 'failed'; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        body = (await request(app).get(`/api/v1/rooms/${roomId}/playback`).set('Authorization', `Bearer ${guestToken}`)).body;
      }
      expect(body.status).toBe('ready');
      // Ya publicado: se sirve {id}/source.mp4 (no el original de incoming/), con los mismos bytes.
      expect(new URL(body.url).pathname).toMatch(new RegExp(`/${videoId}/source\\.mp4$`));
      expect(Buffer.from(await (await fetch(body.url)).arrayBuffer()).equals(video)).toBe(true);
      const palette = await (await fetch(body.ambilightUrl)).json();
      expect(Array.isArray(palette) && palette.length).toBeGreaterThan(0);
      expect(palette[0]).toHaveProperty('t_ms');
    }

    // 6. En vivo: el host carga el vídeo y le da play; la amiga lo recibe por sync-core.
    const ticket = await request(app).post(`/api/v1/rooms/${roomId}/sync-ticket`);
    expect(ticket.status).toBe(200);
    const host = await openSocket(roomId, ticket.body.token);
    const guest = await openSocket(roomId, guestToken);
    expect((await guest.next('STATE')).can_control).toBe(false);
    expect((await host.next('STATE')).can_control).toBe(true);

    host.send({ type: 'LOAD', media_id: videoId, position_ms: 0 });
    const load = await guest.next('LOAD');
    expect(load.media_id).toBe(videoId);
    host.send({ type: 'PLAY', position_ms: 0 });
    expect((await guest.next('PLAY')).status).toBe('playing');
    guest.send({ type: 'PAUSE', position_ms: 0 });
    expect((await guest.next('ERROR')).code).toBe('FORBIDDEN');
    host.close();
    guest.close();

    // 7. (opcional) Un archivo corrupto queda failed y no se sirve.
    if (process.env.WAIT_WORKER) {
      const junk = Buffer.from('esto no es un vídeo');
      const up = await request(app)
        .post(`/api/v1/rooms/${roomId}/media/uploads`)
        .send({ filename: 'roto.mp4', contentType: 'video/mp4', sizeBytes: junk.length });
      expect((await fetch(up.body.uploadUrl, { method: 'PUT', headers: up.body.headers, body: junk })).status).toBe(200);
      expect((await request(app).post(`/api/v1/rooms/${roomId}/media/uploads/${up.body.videoId}/complete`)).status).toBe(200);
      let body: any = {};
      for (let i = 0; i < 60 && body.status !== 'failed' && body.status !== 'ready'; i++) {
        await new Promise((r) => setTimeout(r, 500));
        body = (await request(app).get(`/api/v1/rooms/${roomId}/playback`).set('Authorization', `Bearer ${guestToken}`)).body;
      }
      expect(body).toMatchObject({ mediaId: up.body.videoId, status: 'failed', url: null });
    }
  }, 120_000);
});

async function openSocket(roomId: string, token: string) {
  const ws = new WebSocket(`${SYNC_WS_URL}?room_id=${roomId}&token=${token}`);
  const inbox: any[] = [];
  const waiters: Array<() => void> = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === 'HEARTBEAT') {
      ws.send(JSON.stringify({ event_id: crypto.randomUUID(), type: 'SYNC_CHECK', room_id: roomId, position_ms: 0, echo_server_ts: msg.server_time_ms, occurred_at: new Date().toISOString() }));
      return;
    }
    inbox.push(msg);
    waiters.splice(0).forEach((w) => w());
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`no se pudo abrir ${SYNC_WS_URL}`));
  });
  return {
    send(m: object) {
      ws.send(JSON.stringify({ event_id: crypto.randomUUID(), room_id: roomId, occurred_at: new Date().toISOString(), ...m }));
    },
    async next(type: string, ms = 5000) {
      const end = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() > end) throw new Error(`no llegó ${type}`);
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100); });
      }
    },
    close() { ws.close(); },
  };
}
