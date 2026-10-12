import { m, useReducedMotion } from 'framer-motion';

const ORBS = [
  { className: '-left-40 -top-40 h-[34rem] w-[34rem] bg-tint-accent/[0.14]', drift: { x: [0, 60, 0], y: [0, 40, 0] }, duration: 26 },
  { className: '-right-48 top-1/3 h-[30rem] w-[30rem] bg-tint-accentDark/[0.16]', drift: { x: [0, -50, 0], y: [0, 60, 0] }, duration: 30 },
  { className: 'bottom-[-14rem] left-1/3 h-[26rem] w-[26rem] bg-amber-300/[0.06]', drift: { x: [0, 40, 0], y: [0, -30, 0] }, duration: 22 },
];

/**
 * Fondo ambiental: orbes cálidos muy difusos que respiran lento y un grano sutil.
 * Decorativo (aria-hidden, sin puntero) y estático con movimiento reducido.
 */
export function AmbientBackground() {
  const reduced = useReducedMotion();
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {ORBS.map((orb, i) => (
        <m.div
          key={i}
          data-orb
          className={`absolute rounded-full blur-[110px] ${orb.className}`}
          animate={reduced ? undefined : orb.drift}
          transition={{ duration: orb.duration, repeat: Infinity, ease: 'easeInOut' }}
        />
      ))}
      <div className="absolute inset-0 bg-noise opacity-[0.035] mix-blend-overlay" />
    </div>
  );
}
