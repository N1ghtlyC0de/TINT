import { describe, it, expect, vi, afterEach } from 'vitest';
import { createS3Signer } from '../src/modules/media/media.signer.js';
import { createS3Store, getMediaStore, setMediaStore } from '../src/modules/media/media.store.js';

afterEach(() => setMediaStore(null));

const config = { endpoint: 'http://cdn.tint.local:9000', accessKey: 'k', secretKey: 's', bucket: 'tint-media', region: 'us-east-1' };

describe('presignPut', () => {
  it('firma un PUT path-style que exige el Content-Type declarado', async () => {
    const url = new URL(await createS3Signer(config).presignPut('v1/source.mp4', 'video/mp4', 300));
    expect(url.origin).toBe('http://cdn.tint.local:9000');
    expect(url.pathname).toBe('/tint-media/v1/source.mp4');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('media.store', () => {
  it('stat hace HEAD y devuelve el tamaño real del objeto (ContentLength)', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ContentLength: 1234 });
    const store = createS3Store({ ...config, client: { send } as any });
    await expect(store.stat('v1/source.mp4')).resolves.toEqual({ size: 1234 });
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'tint-media', Key: 'v1/source.mp4' });
  });

  it('stat sin ContentLength devuelve size 0', async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    const store = createS3Store({ ...config, client: { send } as any });
    await expect(store.stat('x')).resolves.toEqual({ size: 0 });
  });

  it('stat devuelve null con 404 / NotFound y propaga otros errores', async () => {
    const notFound = Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    const boom = Object.assign(new Error('down'), { name: 'TimeoutError', $metadata: {} });
    const send = vi.fn().mockRejectedValueOnce(notFound).mockRejectedValueOnce(boom);
    const store = createS3Store({ ...config, client: { send } as any });
    await expect(store.stat('x')).resolves.toBeNull();
    await expect(store.stat('x')).rejects.toThrow('down');
  });

  it('remove hace DeleteObject de la clave', async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    const store = createS3Store({ ...config, client: { send } as any });
    await store.remove('v1/source.mp4');
    expect(send.mock.calls[0][0].constructor.name).toBe('DeleteObjectCommand');
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'tint-media', Key: 'v1/source.mp4' });
  });

  it('getMediaStore usa un cliente S3 por defecto y es sustituible', () => {
    const def = getMediaStore();
    expect(getMediaStore()).toBe(def);
    const fake = { stat: async () => ({ size: 1 }), remove: async () => {} };
    setMediaStore(fake);
    expect(getMediaStore()).toBe(fake);
  });
});
