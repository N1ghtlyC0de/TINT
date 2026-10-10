import { describe, it, expect, afterEach } from 'vitest';
import { createS3Signer, getMediaSigner, setMediaSigner } from '../src/modules/media/media.signer.js';

afterEach(() => {
  setMediaSigner(null);
});

describe('media.signer', () => {
  it('firma un GET SigV4 path-style contra el endpoint público', async () => {
    const signer = createS3Signer({
      endpoint: 'http://cdn.tint.local:9000',
      accessKey: 'tintadmin',
      secretKey: 'tintadmin123',
      bucket: 'tint-media',
      region: 'us-east-1',
    });
    const url = new URL(await signer.presignGet('videos/peli 1.mp4', 120));
    expect(url.origin).toBe('http://cdn.tint.local:9000');
    expect(url.pathname).toBe('/tint-media/videos/peli%201.mp4');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^tintadmin\/\d{8}\/us-east-1\/s3\/aws4_request$/);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('getMediaSigner construye un firmador por defecto desde env y es sustituible', async () => {
    const def = getMediaSigner();
    expect(getMediaSigner()).toBe(def);
    const url = new URL(await def.presignGet('a.mp4', 60));
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/tint-media/a.mp4');

    const fake = { presignGet: async () => 'http://fake' };
    setMediaSigner(fake);
    expect(getMediaSigner()).toBe(fake);
  });
});
