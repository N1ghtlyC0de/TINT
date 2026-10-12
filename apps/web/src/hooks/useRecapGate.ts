import { useCallback, useRef, useState } from 'react';
import type { RecapMessage } from '../lib/socialSocket';

interface RecapGateOptions {
  /** Vídeo actual (`media_id`): el recap se muestra una sola vez por vídeo. */
  mediaKey: string | null | undefined;
  /** Último recap recibido de social-core. */
  recap: RecapMessage | null;
  requestRecap: () => boolean;
}

/**
 * Decide cuándo se ve "Fin de la función". Una vez por vídeo: los `ended` repetidos
 * (el drift o el STATE pueden re-posicionar el vídeo cerca del final) y los recaps
 * nuevos del mismo vídeo se ignoran tras cerrarlo. Otro vídeo o `rearm` lo rearman.
 */
export function useRecapGate({ mediaKey, recap, requestRecap }: RecapGateOptions) {
  const key = mediaKey ?? '';
  const [open, setOpen] = useState(false);
  /** Recap visible antes de pedirlo: no es el de este final. */
  const [stale, setStale] = useState<RecapMessage | null>(null);
  const [handled, setHandled] = useState<RecapMessage | null>(null);
  // Refs: dos `ended` en el mismo tick deben ver el estado actualizado.
  const openRef = useRef(false);
  const dismissedRef = useRef<string | null>(null);

  const setOpenBoth = (value: boolean) => {
    openRef.current = value;
    setOpen(value);
  };

  // Recap nuevo sin pedirlo: se abre solo si este vídeo aún no tuvo su recap.
  if (recap !== handled) {
    setHandled(recap);
    if (recap && !openRef.current && dismissedRef.current !== key) {
      setStale(null);
      setOpenBoth(true);
    }
  }

  const onEnded = useCallback(() => {
    if (openRef.current || dismissedRef.current === key) return;
    requestRecap();
    setStale(recap);
    setOpenBoth(true);
  }, [key, recap, requestRecap]);

  const dismiss = useCallback(() => {
    dismissedRef.current = key;
    setOpenBoth(false);
  }, [key]);

  /** "Volver a verla": el próximo final vuelve a mostrar el recap. */
  const rearm = useCallback(() => {
    dismissedRef.current = null;
    setOpenBoth(false);
  }, []);

  return {
    open,
    recap: open && recap !== stale ? recap : null,
    onEnded,
    dismiss,
    rearm,
  };
}
