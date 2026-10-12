import type { ReactNode } from 'react';
import { m } from 'framer-motion';
import { fadeBlur } from '../../lib/motion';

/** Envoltura de cada ruta: entra con fade + desenfoque y sale breve (AnimatePresence en App). */
export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <m.div variants={fadeBlur} initial="hidden" animate="show" exit="exit">
      {children}
    </m.div>
  );
}
