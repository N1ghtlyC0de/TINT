import type { Transition, Variants } from 'framer-motion';

/**
 * Presets de movimiento de TINT: una sola curva y un solo spring para que toda la
 * interfaz se mueva igual. Las variantes usan las etiquetas `hidden` → `show`.
 * `MotionConfig reducedMotion="user"` (ver MotionProvider) anula los transforms
 * cuando el sistema pide menos movimiento.
 */
export const ease = [0.22, 1, 0.36, 1] as const;

export const spring = { type: 'spring', stiffness: 380, damping: 30, mass: 0.8 } as const satisfies Transition;

const smooth: Transition = { duration: 0.45, ease };

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: smooth },
  exit: { opacity: 0, y: -6, transition: { duration: 0.2, ease } },
};

export const fadeBlur: Variants = {
  hidden: { opacity: 0, y: 8, filter: 'blur(6px)' },
  // `filter: none` al final: un filtro residual convertiría al wrapper en el bloque
  // contenedor de los `position: fixed` (toasts, diálogos, fondo ambiental).
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: smooth, transitionEnd: { filter: 'none' } },
  exit: { opacity: 0, y: -4, filter: 'blur(4px)', transition: { duration: 0.2, ease } },
};

export const pop: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  show: { opacity: 1, scale: 1, transition: spring },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.15 } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  show: { opacity: 1, scale: 1, transition: smooth },
};

/** Contenedor que escalona la entrada de sus hijos (que usen variantes `hidden`/`show`). */
export function stagger(staggerChildren = 0.05, delayChildren = 0): Variants {
  return {
    hidden: {},
    show: { transition: { staggerChildren, delayChildren } },
  };
}
