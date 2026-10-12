import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig, domAnimation } from 'framer-motion';

/**
 * Raíz de animación de la app: carga solo las features `domAnimation` (animate,
 * exit, variants, hover/tap) para los componentes `m.*` y respeta
 * `prefers-reduced-motion`. Sin `strict`: el cuestionario `/test-me` (lazy) sigue
 * usando `motion.*` con su propio bundle.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
