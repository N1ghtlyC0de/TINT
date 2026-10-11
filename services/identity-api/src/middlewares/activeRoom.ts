import { Request, Response, NextFunction } from 'express';
import { findById, type Room } from '../modules/rooms/rooms.repo.js';

declare module 'express-serve-static-core' {
  interface Request {
    room?: Room;
  }
}

/**
 * Carga la sala `:id` y corta si no existe (404) o tiene borrado lógico (410),
 * con las mismas respuestas que el resto de rutas de salas. Deja la sala en `req.room`.
 * Va después de la autorización: así un tercero no puede sondear qué salas existen.
 */
export async function requireActiveRoom(req: Request, res: Response, next: NextFunction) {
  const rawId = req.params.id;
  const roomId = Array.isArray(rawId) ? rawId[0] : rawId;
  let room: Room | null;
  try {
    room = await findById(roomId);
  } catch (err) {
    console.error('[activeRoom] no se pudo leer la sala:', (err as Error).message);
    return res.status(500).json({ error: 'Internal error' });
  }
  if (!room) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (room.status === 'deleted') {
    return res.status(410).json({ error: 'Deleted' });
  }
  req.room = room;
  next();
}
