import { getRedisClient } from '../tokens/revocation.js';

/**
 * Stream que consume media-worker (grupo `media-workers`): cada evento lleva solo
 * `video_id`; el worker lee `videos.storage_key`, inspecciona con ffprobe, publica
 * `{video_id}/ambilight.json` y deja el vídeo en `ready` o `failed`.
 */
export const MEDIA_UPLOADS_STREAM = 'media:uploads';

export async function enqueueMediaUpload(videoId: string) {
  return getRedisClient().xadd(MEDIA_UPLOADS_STREAM, '*', 'video_id', videoId);
}
