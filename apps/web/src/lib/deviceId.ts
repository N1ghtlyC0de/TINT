/**
 * Identificador anónimo del navegador (`tint_device_id`), que se envía al canjear una
 * invitación para que el host pueda bloquear por dispositivo. Borrar los datos del
 * navegador lo cambia (limitación documentada en docs/usuarios-e-identidad.md).
 */
export const DEVICE_ID_KEY = 'tint_device_id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Respaldo en memoria si el almacenamiento está bloqueado (ventana privada, etc.). */
let cached: string | null = null;

export function resetDeviceIdCache() {
  cached = null;
}

/** UUID estable del dispositivo, o null si el navegador no puede generarlo. */
export function getDeviceId(): string | null {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored && UUID_RE.test(stored)) {
      cached = stored;
      return stored;
    }
  } catch {
    // Almacenamiento no disponible: vale el de memoria (o se genera uno).
    if (cached) return cached;
  }
  let id: string;
  try {
    id = crypto.randomUUID();
  } catch {
    return null;
  }
  cached = id;
  try {
    localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Sin persistencia: vale para esta pestaña.
  }
  return id;
}
