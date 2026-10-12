import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { m } from 'framer-motion';
import { fadeUp, stagger } from '../../lib/motion';

type ListProps = Omit<ComponentPropsWithoutRef<'ul'>, 'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'> & {
  children: ReactNode;
  /** Segundos entre la entrada de cada hijo. */
  step?: number;
};

/** Lista cuyos `StaggerItem` entran uno tras otro (fade + subida). */
export function StaggerList({ children, step = 0.05, ...rest }: ListProps) {
  return (
    <m.ul {...rest} variants={stagger(step)} initial="hidden" animate="show">
      {children}
    </m.ul>
  );
}

type ItemProps = Omit<ComponentPropsWithoutRef<'li'>, 'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'> & {
  children: ReactNode;
};

export function StaggerItem({ children, ...rest }: ItemProps) {
  return (
    <m.li {...rest} variants={fadeUp}>
      {children}
    </m.li>
  );
}
