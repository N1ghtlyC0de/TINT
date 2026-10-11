import { useEffect, useRef } from 'react';

export const SHORTCUT_SEEK_MS = 10_000;

export interface PlayerShortcutHandlers {
  onTogglePlay: () => void;
  onSeekBy: (deltaMs: number) => void;
  onRateStep: (direction: 1 | -1) => void;
  onToggleHelp: () => void;
}

/** Lista para la ayuda visible y los `aria-keyshortcuts`. */
export const PLAYER_SHORTCUTS = [
  { keys: 'Espacio / K', action: 'Reproducir o pausar' },
  { keys: '← / J', action: 'Retroceder 10 s' },
  { keys: '→ / L', action: 'Avanzar 10 s' },
  { keys: '[ / ]', action: 'Bajar o subir la velocidad' },
  { keys: '?', action: 'Mostrar u ocultar esta ayuda' },
] as const;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.contentEditable === 'true') return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function activatesWithSpace(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('button, a, [role="button"], summary');
}

/**
 * Atajos de teclado del reproductor para quien tiene el control. Se ignoran con el foco
 * en campos de texto, con modificadores y si otro control ya atendió la tecla
 * (`defaultPrevented`, p. ej. las flechas sobre la barra de progreso).
 */
export function usePlayerShortcuts(enabled: boolean, handlers: PlayerShortcutHandlers) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const h = ref.current;
      switch (e.key) {
        case ' ':
          if (activatesWithSpace(e.target)) return;
          h.onTogglePlay();
          break;
        case 'k':
        case 'K':
          h.onTogglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          h.onSeekBy(-SHORTCUT_SEEK_MS);
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          h.onSeekBy(SHORTCUT_SEEK_MS);
          break;
        case '[':
          h.onRateStep(-1);
          break;
        case ']':
          h.onRateStep(1);
          break;
        case '?':
          h.onToggleHelp();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
