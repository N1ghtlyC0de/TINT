import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { apiFetch, ApiError } from '../../lib/api';
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

/**
 * Panel del host para cambiar el vídeo de la sala (contrato v2 §2/§9): primero
 * `PUT /rooms/:id/media` en identity-api y, con el `mediaId` devuelto, LOAD por el canal.
 */
export function ChangeVideoPanel({ roomId, onMediaAssigned }: ChangeVideoPanelProps) {
  const [open, setOpen] = useState(false);
  const [mediaKey, setMediaKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const inputId = useId();

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const key = mediaKey.trim();
    if (!key) return;
    setSaving(true);
    setError('');
    setDone(false);
    try {
      const res = (await apiFetch(
        `/rooms/${encodeURIComponent(roomId)}/media`,
        { method: 'PUT', body: JSON.stringify({ mediaKey: key }) },
        'host',
      )) as AssignMediaResponse;
      if (onMediaAssigned(res.mediaId)) {
        setDone(true);
        setMediaKey('');
      } else {
        setError('El vídeo quedó asignado, pero no se pudo avisar a la sala. Revisa la conexión e inténtalo de nuevo.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo asignar el vídeo.');
    } finally {
      setSaving(false);
    }
  };

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
        <form id={panelId} onSubmit={submit} onKeyDown={onKeyDown} className="mt-4 flex flex-col gap-3">
          <label htmlFor={inputId} className="text-sm font-medium text-white">
            Clave del objeto en MinIO
          </label>
          <input
            id={inputId}
            ref={inputRef}
            value={mediaKey}
            onChange={(e) => setMediaKey(e.target.value)}
            placeholder="peliculas/mi-video.mp4"
            autoComplete="off"
            spellCheck={false}
            className="rounded-xl border border-white/10 bg-tint-bg px-3 py-2 font-mono text-sm text-white placeholder:text-tint-muted/50 focus:border-tint-accent focus:outline-none"
          />
          <p className="text-[13px] leading-relaxed text-tint-muted/80">
            Ruta del archivo dentro del bucket. La sala se pausará al inicio del nuevo vídeo.
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={saving || !mediaKey.trim()}>
              {saving ? 'Asignando…' : 'Asignar y cargar'}
            </Button>
            <Button type="button" variant="quiet" onClick={close}>
              Cerrar
            </Button>
          </div>
          <ErrorAlert message={error} />
          {done && (
            <p role="status" className="text-[13px] text-emerald-300">
              Vídeo cargado en la sala.
            </p>
          )}
        </form>
      )}
    </div>
  );
}
