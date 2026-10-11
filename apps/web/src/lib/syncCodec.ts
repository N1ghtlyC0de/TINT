/**
 * Codificación de frames del Canal Sync (contrato v2 §7).
 *
 * JSON (texto) es el default. Con `VITE_SYNC_ENCODING=msgpack` el cliente pide el
 * subprotocolo `tint.sync.msgpack`; si el servidor lo acepta, todos los frames son
 * binarios MessagePack con exactamente las mismas claves que el JSON y los timestamps
 * como string ISO-8601 (no se usa la extensión timestamp).
 */
import { decode, encode } from '@msgpack/msgpack';

export type SyncEncoding = 'json' | 'msgpack';

export const MSGPACK_SUBPROTOCOL = 'tint.sync.msgpack';

export function resolveEncoding(value: string | undefined): SyncEncoding {
  return value?.trim().toLowerCase() === 'msgpack' ? 'msgpack' : 'json';
}

export function encodeFrame(msg: object, encoding: SyncEncoding): string | Uint8Array {
  if (encoding === 'json') return JSON.stringify(msg);
  // ignoreUndefined: igual que JSON.stringify, las claves sin valor no viajan.
  return encode(msg, { ignoreUndefined: true });
}

function isBinary(data: unknown): data is ArrayBuffer | ArrayBufferView {
  return ArrayBuffer.isView(data) || Object.prototype.toString.call(data) === '[object ArrayBuffer]';
}

/**
 * Decodifica un frame según su tipo real (texto → JSON, binario → MessagePack), así un
 * servidor que no aceptó el subprotocolo sigue funcionando. null si no se puede leer.
 */
export function decodeFrame(data: unknown): unknown {
  try {
    if (typeof data === 'string') return JSON.parse(data);
    if (isBinary(data)) return decode(data);
  } catch {
    return null;
  }
  return null;
}
