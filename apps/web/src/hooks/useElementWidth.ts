import { useEffect, useState } from 'react';

/**
 * Ancho en px de un elemento, actualizado con ResizeObserver. Los gráficos SVG lo usan
 * como ancho del viewBox para que el texto conserve su tamaño real en cualquier
 * pantalla. Devuelve un callback ref (funciona aunque el elemento aparezca después del
 * primer render, p. ej. tras un estado vacío). Sin ResizeObserver (jsdom) → `fallback`.
 */
export function useElementWidth<T extends Element>(fallback: number): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.round(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return [setEl, width];
}
