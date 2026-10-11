import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { apiFetch, ApiError } from '../../lib/api';
import { completeUpload, requestUpload, uploadErrorMessage, uploadToBlob, UploadError } from '../../lib/upload';
import { Button } from '../ui/Button';
import { ErrorAlert } from '../ui/Primitives';

export interface ChangeVideoPanelProps {
  roomId: string;
  /** Envía LOAD{media_id} por el canal; false si no se pudo (sin conexión o sin control). */
  onMediaAssigned: (mediaId: string) => boolean;
}

interface AssignMediaResponse {
  mediaId: string;
  mediaKey?: string;
}

type Phase =
  | 'idle'
  | 'uploading'
  | 'confirming'
  | 'assigning'
  | 'done'
  | 'cancelled'
  /** El vídeo quedó asignado en identity-api pero el LOAD no salió por el canal. */
  | 'notify-failed'
  | 'error';

const NOTIFY_FAILED =
  'El vídeo quedó asignado, pero no se pudo avisar a la sala (sin conexión con el Canal Sync). ' +
  'Pulsa «Avisar a la sala» cuando vuelva la conexión.';

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const inputClass =
  'rounded-xl border border-white/10 bg-tint-bg px-3 py-2 text-sm text-white focus:border-tint-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60';

/**
 * Panel del host para cambiar el vídeo de la sala.
 *
 * Opción principal — subir desde el navegador: `POST /rooms/:id/media/uploads` (URL
 * pre-firmada) → `PUT` directo a MinIO con progreso → `POST …/complete` (asigna el vídeo
 * y encola el procesamiento) → LOAD{media_id} por el Canal Sync.
 * Opción secundaria — un objeto ya presente en el bucket: `PUT /rooms/:id/media` → LOAD.
 */
export function ChangeVideoPanel({ roomId, onMediaAssigned }: ChangeVideoPanelProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const [mediaKey, setMediaKey] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [pendingMediaId, setPendingMediaId] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelId = useId();
  const fileId = useId();
  const fileHelpId = useId();
  const keyId = useId();

  const busy = phase === 'uploading' || phase === 'confirming' || phase === 'assigning';

  useEffect(() => {
    if (open) fileRef.current?.focus();
  }, [open]);

  // Si el panel desaparece (cambio de página), no se deja un PUT huérfano.
  useEffect(() => () => abortRef.current?.abort(), []);

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  /** Envía LOAD; si el canal no está disponible guarda el mediaId para reintentar. */
  const notifyRoom = (mediaId: string) => {
    if (onMediaAssigned(mediaId)) {
      setPendingMediaId(null);
      setError('');
      setPhase('done');
      return true;
    }
    setPendingMediaId(mediaId);
    setError(NOTIFY_FAILED);
    setPhase('notify-failed');
    return false;
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files?.[0] ?? null;
    setPhase('idle');
    setPendingMediaId(null);
    if (next && !next.type.startsWith('video/')) {
      setFile(null);
      setError('El archivo elegido no es un vídeo. Elige un archivo de vídeo (MP4, WebM…).');
      return;
    }
    setError('');
    setFile(next);
  };

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError('');
    setPendingMediaId(null);
    setProgress(0);
    setPhase('uploading');
    try {
      const ticket = await requestUpload(roomId, file);
      await uploadToBlob(ticket.uploadUrl, file, ticket.headers, setProgress, ctrl.signal);
      setPhase('confirming');
      const done = await completeUpload(roomId, ticket.videoId);
      if (notifyRoom(done.mediaId)) {
        setFile(null);
        setFileInputKey((k) => k + 1);
      }
    } catch (err) {
      if (ctrl.signal.aborted) {
        // Desmontado o cancelado por el usuario: no hay nada más que hacer.
        if (err instanceof UploadError && err.kind === 'abort') setPhase('cancelled');
        return;
      }
      setError(uploadErrorMessage(err));
      setPhase('error');
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const assignByKey = async (e: FormEvent) => {
    e.preventDefault();
    const key = mediaKey.trim();
    if (!key || busy) return;
    setPhase('assigning');
    setError('');
    setPendingMediaId(null);
    try {
      const res = (await apiFetch(
        `/rooms/${encodeURIComponent(roomId)}/media`,
        { method: 'PUT', body: JSON.stringify({ mediaKey: key }) },
        'host',
      )) as AssignMediaResponse;
      if (notifyRoom(res.mediaId)) setMediaKey('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo asignar el vídeo.');
      setPhase('error');
    }
  };

  const statusText =
    phase === 'uploading'
      ? `Subiendo… ${progress} %`
      : phase === 'confirming'
        ? 'Confirmando la subida…'
        : phase === 'done'
          ? 'Vídeo cargado para todos.'
          : phase === 'cancelled'
            ? 'Subida cancelada.'
            : '';

  return (
    <div>
      <Button
        ref={toggleRef}
        variant="ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Cambiar vídeo
      </Button>
      {open && (
        <div id={panelId} onKeyDown={onKeyDown} className="mt-4 flex flex-col gap-4">
          <form onSubmit={upload} className="flex flex-col gap-3">
            <label htmlFor={fileId} className="text-sm font-medium text-white">
              Archivo de vídeo
            </label>
            <input
              key={fileInputKey}
              id={fileId}
              ref={fileRef}
              type="file"
              accept="video/*"
              onChange={onFileChange}
              disabled={busy}
              aria-describedby={fileHelpId}
              className={`${inputClass} file:mr-3 file:rounded-full file:border-0 file:bg-white/10 file:px-3 file:py-1 file:text-sm file:font-medium file:text-white disabled:opacity-50`}
            />
            <p id={fileHelpId} className="text-[13px] leading-relaxed text-tint-muted">
              {file
                ? `${file.name} · ${formatSize(file.size)}`
                : 'Se sube directo al almacenamiento. La sala se pausará al inicio del nuevo vídeo.'}
            </p>

            {(phase === 'uploading' || phase === 'confirming') && (
              <div
                role="progressbar"
                aria-label="Progreso de subida"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={phase === 'confirming' ? 100 : progress}
                aria-valuetext={statusText}
                className="h-2 overflow-hidden rounded-full bg-white/10"
              >
                <div
                  className="h-full rounded-full bg-tint-accent transition-[width] duration-200 motion-reduce:transition-none"
                  style={{ width: `${phase === 'confirming' ? 100 : progress}%` }}
                />
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {phase === 'uploading' ? (
                <Button type="button" variant="ghost" onClick={cancel}>
                  Cancelar subida
                </Button>
              ) : (
                <Button type="submit" disabled={!file || busy}>
                  Subir
                </Button>
              )}
              <Button type="button" variant="quiet" onClick={close}>
                Cerrar
              </Button>
            </div>
          </form>

          <p
            role="status"
            aria-live="polite"
            className={phase === 'done' ? 'text-[13px] text-emerald-300' : 'text-[13px] text-tint-muted'}
          >
            {statusText}
          </p>
          <ErrorAlert message={error} />
          {phase === 'notify-failed' && pendingMediaId && (
            <Button type="button" variant="ghost" onClick={() => notifyRoom(pendingMediaId)} className="self-start">
              Avisar a la sala
            </Button>
          )}

          <details className="rounded-xl border border-white/10 px-3 py-2">
            <summary className="cursor-pointer rounded text-[13px] font-medium text-tint-muted hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent/60">
              Usar un archivo ya subido (clave del bucket)
            </summary>
            <form onSubmit={assignByKey} className="mt-3 flex flex-col gap-3">
              <label htmlFor={keyId} className="text-sm font-medium text-white">
                Clave del objeto en MinIO
              </label>
              <input
                id={keyId}
                value={mediaKey}
                onChange={(e) => setMediaKey(e.target.value)}
                placeholder="peliculas/mi-video.mp4"
                autoComplete="off"
                spellCheck={false}
                className={`${inputClass} font-mono placeholder:text-tint-muted/50`}
              />
              <p className="text-[13px] leading-relaxed text-tint-muted">
                Ruta del archivo dentro del bucket (sin procesamiento Ambilight).
              </p>
              <Button type="submit" disabled={busy || !mediaKey.trim()} className="self-start">
                {phase === 'assigning' ? 'Asignando…' : 'Asignar y cargar'}
              </Button>
            </form>
          </details>
        </div>
      )}
    </div>
  );
}
