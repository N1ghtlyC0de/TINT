const API_URL = import.meta.env.VITE_IDENTITY_API_URL || 'http://localhost:8081/api/v1';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Qué credencial enviar: `auto` (host si existe, si no guest), `host` (solo el token de
 * Firebase `tint_token`) o `guest` (solo `tint_guest_token`, p. ej. el invitado en
 * `GET /rooms/:id/playback` aunque el navegador conserve una sesión de host).
 */
export type ApiAuth = 'auto' | 'host' | 'guest';

function bearerFor(auth: ApiAuth): string | null {
  const token = localStorage.getItem('tint_token');
  const guestToken = localStorage.getItem('tint_guest_token');
  if (auth === 'host') return token;
  if (auth === 'guest') return guestToken;
  return token || guestToken;
}

export async function apiFetch(path: string, options: RequestInit = {}, auth: ApiAuth = 'auto') {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  const bearer = bearerFor(auth);
  if (bearer) {
    headers.set('Authorization', `Bearer ${bearer}`);
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error || `API error ${res.status}`);
  }
  return res.json();
}
