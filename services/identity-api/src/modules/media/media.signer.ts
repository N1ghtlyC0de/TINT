import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';

/** Firma URLs GET temporales de objetos del bucket de medios. */
export interface MediaSigner {
  presignGet(key: string, ttlSeconds: number): Promise<string>;
}

export interface S3SignerConfig {
  /** Endpoint con el que se firma: debe ser el host que usará el navegador. */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

/**
 * Firmador SigV4 compatible con MinIO (path-style). El pre-firmado es un
 * cálculo local: no hace ninguna petición de red a MinIO.
 */
export function createS3Signer(config: S3SignerConfig): MediaSigner {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
  });
  return {
    presignGet(key, ttlSeconds) {
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
      return getSignedUrl(client, command, { expiresIn: ttlSeconds });
    },
  };
}

let signer: MediaSigner | null = null;

export function getMediaSigner(): MediaSigner {
  if (!signer) {
    signer = createS3Signer({
      endpoint: env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET,
      region: env.MINIO_REGION,
    });
  }
  return signer;
}

/** Inyección para pruebas (null restaura el firmador por defecto). */
export function setMediaSigner(next: MediaSigner | null) {
  signer = next;
}
