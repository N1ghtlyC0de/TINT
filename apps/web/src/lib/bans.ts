import { apiFetch, ApiError } from './api';

/** Bloqueo por dispositivo de un invitado (`room_bans` en identity-api). */
export interface RoomBan {
  id: string;
  nick: string;
  createdAt: string;
}

const base = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}/bans`;

/** Bloquea a un invitado: `{jti}` desde Participantes o `{sub}` desde el chat. Revoca sus sesiones. */
export async function banGuest(roomId: string, target: { jti: string } | { sub: string }): Promise<RoomBan> {
  const res = (await apiFetch(base(roomId), { method: 'POST', body: JSON.stringify(target) }, 'host')) as { ban: RoomBan };
  return res.ban;
}

export async function listBans(roomId: string): Promise<RoomBan[]> {
  const res = (await apiFetch(base(roomId), { method: 'GET' }, 'host')) as { bans?: RoomBan[] } | null;
  return res?.bans ?? [];
}

export async function unbanGuest(roomId: string, banId: string): Promise<void> {
  await apiFetch(`${base(roomId)}/${encodeURIComponent(banId)}`, { method: 'DELETE' }, 'host');
}

/** Mensaje simple para un fallo al bloquear. */
export function banErrorMessage(err: unknown, nick: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return `${nick} ya no está en la sala como invitado.`;
    if (err.status === 503) return 'El servicio no está disponible ahora. Inténtalo en un momento.';
    if (err.status === 403) return 'No tienes permiso para bloquear en esta sala.';
  }
  return `No se pudo bloquear a ${nick}. Inténtalo de nuevo.`;
}
