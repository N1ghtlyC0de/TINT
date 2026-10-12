import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig } from 'framer-motion';

const loadFeatures = () => import('./features').then((mod) => mod.default);

/**
 * Raíz de animación de la app: carga en diferido (chunk propio) solo las features
 * `domAnimation` (animate, exit, variants, hover/tap) para los componentes `m.*`; hasta
 * que llegan, `m.*` renderiza sin animar. Respeta
 * `prefers-reduced-motion`. Sin `strict`: el cuestionario `/test-me` (lazy) sigue
 * usando `motion.*` con su propio bundle.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
