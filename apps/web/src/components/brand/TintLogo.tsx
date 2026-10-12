import { useId } from 'react';

/** Por debajo de este tamaño (px) se usa la variante simplificada (la del favicon). */
export const TINT_LOGO_COMPACT_BELOW = 24;

export interface TintLogoProps {
  /** Lado en px (el logo es cuadrado). */
  size?: number;
  /** Nombre accesible; se ignora si es decorativo. */
  label?: string;
  /** Junto a un texto o enlace que ya nombra la marca: se oculta a lectores de pantalla. */
  decorative?: boolean;
  className?: string;
}

/**
 * Logo de TINT en SVG en línea (mismo dibujo que `public/logo.svg` y `public/favicon.svg`):
 * anillo abierto, "T" de trazo redondeado y llama, con gradiente amarillo → naranja.
 */
export function TintLogo({ size = 36, label = 'TINT', decorative = false, className }: TintLogoProps) {
  const gradientId = `tint-logo-${useId().replace(/:/g, '')}`;
  const compact = size < TINT_LOGO_COMPACT_BELOW;
  const paint = `url(#${gradientId})`;
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="120 120 272 272"
      width={size}
      height={size}
      data-variant={compact ? 'compact' : 'full'}
      className={className}
      focusable="false"
      {...a11y}
    >
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="150" y1="380" x2="380" y2="140">
          <stop offset="0" stopColor="#FFC93C" />
          {!compact && <stop offset="0.55" stopColor="#FFB02E" />}
          <stop offset="1" stopColor="#FF8A1A" />
        </linearGradient>
      </defs>
      {compact ? (
        <>
          <g fill="none" stroke={paint} strokeWidth="24" strokeLinecap="round">
            <path d="M200 356 A116 116 0 0 1 316 148" />
            <path d="M368 222 A116 116 0 0 1 252 372" />
            <path d="M200 200 H312" />
            <path d="M256 204 V318" />
          </g>
          <path fill={paint} d="M316 196 C334 170 362 166 380 136 C402 178 388 214 342 218 C330 218 320 210 316 196 Z" />
        </>
      ) : (
        <>
          <g fill="none" stroke={paint} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M206.6 365.0 A120 120 0 0 1 320.0 154.4" />
            <path d="M369.6 219.8 A120 120 0 0 1 252 376" />
            <path d="M212 188 H314 Q338 188 352 172 Q342 214 304 216 H284 Q270 216 270 230 V318 A14 14 0 0 1 242 318 V230 Q242 216 228 216 H212 A14 14 0 0 1 212 188 Z" />
            <path d="M242 340 C238 360 240 372 252 376" />
          </g>
          <path fill={paint} d="M330 190 C346 172 368 168 380 144 C396 176 386 204 352 207 C344 207 336 201 330 190 Z" />
        </>
      )}
    </svg>
  );
}
