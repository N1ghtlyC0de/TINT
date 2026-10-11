import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';

/** Consultas al bucket desde el servidor (endpoint interno, no el público). */
export interface MediaStore {
  exists(key: string): Promise<boolean>;
}

export interface S3StoreConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  /** Cliente inyectable para pruebas. */
  client?: Pick<S3Client, 'send'>;
}

export function createS3Store(config: S3StoreConfig): MediaStore {
  const client =
    config.client ??
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    });
  return {
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return true;
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return false;
        throw err;
      }
    },
  };
}

let store: MediaStore | null = null;

export function getMediaStore(): MediaStore {
  if (!store) {
    store = createS3Store({
      endpoint: env.MINIO_ENDPOINT,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET,
      region: env.MINIO_REGION,
    });
  }
  return store;
}

/** Inyección para pruebas (null restaura el cliente por defecto). */
export function setMediaStore(next: MediaStore | null) {
  store = next;
}
