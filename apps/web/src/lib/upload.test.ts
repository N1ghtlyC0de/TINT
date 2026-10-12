import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockXhr } from '../test/mockXhr';
import { apiFetch, ApiError } from './api';
import { completeUpload, requestUpload, uploadErrorMessage, uploadToBlob, UploadError } from './upload';

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

const file = new File(['abc'], 'peli.mp4', { type: 'video/mp4' });

beforeEach(() => {
  MockXhr.reset();
  vi.stubGlobal('XMLHttpRequest', MockXhr);
  mockedApiFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadToBlob', () => {
  it('hace PUT directo con el archivo y exactamente las cabeceras dadas', async () => {
    const p = uploadToBlob('https://minio/put?sig=1', file, { 'Content-Type': 'video/mp4' });
    const xhr = MockXhr.last();
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://minio/put?sig=1');
    expect(xhr.headers).toEqual({ 'Content-Type': 'video/mp4' });
    expect(xhr.headers).not.toHaveProperty('Authorization');
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.body).toBe(file);
    xhr.respond(200);
    await expect(p).resolves.toBeUndefined();
  });

  it('informa el progreso en porcentaje entero (0–100)', async () => {
    const onProgress = vi.fn();
    const p = uploadToBlob('u', file, {}, onProgress);
    const xhr = MockXhr.last();
    xhr.progress(42, 100);
    xhr.progress(1, 3);
    xhr.progress(5, 0, false);
    xhr.respond(204);
    await p;
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([42, 33]);
  });

  it('rechaza con UploadError http si el estado no es 2xx', async () => {
    const p = uploadToBlob('u', file, {});
    MockXhr.last().respond(403);
    await expect(p).rejects.toMatchObject({ name: 'UploadError', kind: 'http', status: 403 });
  });

  it('rechaza con UploadError network ante un error de red', async () => {
    const p = uploadToBlob('u', file, {});
    MockXhr.last().fail();
    await expect(p).rejects.toMatchObject({ kind: 'network', status: 0 });
  });

  it('aborta con la señal y rechaza con kind abort', async () => {
    const ctrl = new AbortController();
    const p = uploadToBlob('u', file, {}, undefined, ctrl.signal);
    ctrl.abort();
    expect(MockXhr.last().aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ kind: 'abort' });
  });

  it('no envía nada si la señal ya estaba abortada', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(uploadToBlob('u', file, {}, undefined, ctrl.signal)).rejects.toBeInstanceOf(UploadError);
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('deja de escuchar la señal al terminar', async () => {
    const ctrl = new AbortController();
    const p = uploadToBlob('u', file, {}, undefined, ctrl.signal);
    const xhr = MockXhr.last();
    xhr.respond(200);
    await p;
    ctrl.abort();
    expect(xhr.aborted).toBe(false);
  });
});

describe('requestUpload / completeUpload', () => {
  it('pide la URL pre-firmada con los metadatos del archivo y token de host', async () => {
    const res = {
      videoId: 'v1',
      uploadUrl: 'https://minio/put',
      storageKey: 'v1/source.mp4',
      expiresAt: '2026-01-01T00:00:00Z',
      headers: { 'Content-Type': 'video/mp4' },
    };
    mockedApiFetch.mockResolvedValue(res);
    await expect(requestUpload('r 1', file)).resolves.toEqual(res);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r%201/media/uploads',
      {
        method: 'POST',
        body: JSON.stringify({ filename: 'peli.mp4', contentType: 'video/mp4', sizeBytes: 3 }),
      },
      'host',
    );
  });

  it('si la respuesta no trae cabeceras usa el Content-Type del archivo', async () => {
    mockedApiFetch.mockResolvedValue({ videoId: 'v1', uploadUrl: 'u', storageKey: 'k', expiresAt: 'x' });
    const res = await requestUpload('r1', file);
    expect(res.headers).toEqual({ 'Content-Type': 'video/mp4' });
  });

  it('confirma la subida sin cuerpo', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'v1', mediaKey: 'v1/source.mp4', status: 'pending' });
    await expect(completeUpload('r1', 'v 1')).resolves.toEqual({
      mediaId: 'v1',
      mediaKey: 'v1/source.mp4',
      status: 'pending',
    });
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r1/media/uploads/v%201/complete', { method: 'POST' }, 'host');
  });
});

describe('uploadErrorMessage', () => {
  it.each([
    [new ApiError(413, 'File too large'), /supera el tamaño máximo/],
    [new ApiError(400, 'File too large'), /supera el tamaño máximo/],
    [new ApiError(400, 'contentType must be video/*'), /^No se pudo subir el vídeo\. Inténtalo de nuevo\.$/],
    [new ApiError(409, 'Upload missing'), /no terminó de llegar; inténtalo de nuevo/],
    [new ApiError(403, 'Forbidden'), /permiso/],
    [new ApiError(404, 'Not found'), /no existe/],
    [new ApiError(410, 'Gone'), /cerrada/],
    [new ApiError(500, 'boom'), /^No se pudo subir el vídeo\. Inténtalo de nuevo\.$/],
    [new UploadError('http', 403), /^No se pudo subir el vídeo: el permiso de subida pudo caducar\. Inténtalo de nuevo\.$/],
    [new UploadError('network', 0), /Se perdió la conexión durante la subida/],
    [new UploadError('abort', 0), /cancelada/],
    [new TypeError('x'), /No se pudo subir el vídeo/],
  ])('%s', (err, expected) => {
    const text = uploadErrorMessage(err);
    expect(text).toMatch(expected);
    // Sin jerga técnica visible.
    expect(text).not.toMatch(/HTTP|MinIO|bucket|almacenamiento|status/i);
  });
});
