import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { m } from 'framer-motion';
import { spring } from '../../lib/motion';

// Regla de forma: botones pill, cards rounded-2xl, inputs rounded-xl.
type Variant = 'primary' | 'ghost' | 'quiet' | 'danger';
type Size = 'md' | 'sm';

const styles: Record<Variant, string> = {
  primary:
    'bg-accent-sheen text-tint-bg shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:shadow-glow hover:brightness-[1.06] focus-visible:ring-tint-accent',
  ghost: 'tint-glass text-white hover:bg-white/[0.09] hover:border-white/20 focus-visible:ring-tint-accent/60',
  quiet: 'text-tint-muted hover:text-white hover:bg-white/5 focus-visible:ring-white/30',
  danger: 'bg-red-500/90 text-white hover:bg-red-500 hover:shadow-[0_8px_30px_-8px_rgba(239,68,68,0.6)] focus-visible:ring-red-400',
};

const sizes: Record<Size, string> = {
  md: 'px-5 py-2.5 text-sm',
  // min-h-10 en móvil: objetivo táctil de 40 px; en sm+ vuelve a la píldora compacta.
  sm: 'min-h-10 px-3.5 py-1.5 text-[13px] sm:min-h-0',
};

/** Clases compartidas por `Button` y `ButtonLink`. */
export function buttonClasses(variant: Variant = 'primary', size: Size = 'md', className = '') {
  return `inline-flex max-w-full items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold transition-[background-color,box-shadow,color,border-color,filter] duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-tint-bg disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${styles[variant]} ${className}`;
}

type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'
> & { variant?: Variant; size?: Size };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className = '', disabled, ...rest },
  ref,
) {
  return (
    <m.button
      ref={ref}
      {...rest}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={spring}
      className={buttonClasses(variant, size, className)}
    />
  );
});

/** Enlace de React Router con la forma y variantes de `Button`. */
export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: LinkProps & { variant?: Variant; size?: Size }) {
  return <Link {...rest} className={`${buttonClasses(variant, size, className)} active:scale-[0.98]`} />;
}
