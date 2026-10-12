/**
 * Código HTTP de un error de `apiFetch` (`ApiError.status`), o null si no lo tiene.
 * Se lee por forma y no con `instanceof` para no depender de la clase concreta.
 */
export function errorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}
