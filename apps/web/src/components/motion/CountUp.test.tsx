import { render, screen } from '@testing-library/react';
import { CountUp } from './CountUp';

describe('CountUp', () => {
  it('termina mostrando el valor final con números tabulares', async () => {
    render(<CountUp value={1234} />);
    const el = await screen.findByText('1234');
    expect(el).toHaveClass('tabular-nums');
  });

  it('acepta un formateador', async () => {
    render(<CountUp value={42} format={(n) => `${n} ms`} />);
    expect(await screen.findByText('42 ms')).toBeInTheDocument();
  });

  it('se actualiza cuando cambia el valor', async () => {
    const { rerender } = render(<CountUp value={1} />);
    await screen.findByText('1');
    rerender(<CountUp value={7} />);
    expect(await screen.findByText('7')).toBeInTheDocument();
  });
});

describe('CountUp animado', () => {
  it('cuenta frame a frame con salida suave hasta el valor final', async () => {
    const { act } = await import('@testing-library/react');
    const { vi } = await import('vitest');
    const { MotionGlobalConfig } = await import('framer-motion');
    // Reloj y frames controlados: el rAF de jsdom no es determinista bajo cobertura.
    let now = 0;
    let pending: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => pending.push(cb));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const frame = (ms: number) =>
      act(() => {
        now += ms;
        const run = pending;
        pending = [];
        run.forEach((cb) => cb(now));
      });
    MotionGlobalConfig.skipAnimations = false;
    try {
      const { unmount } = render(<CountUp value={10} />);
      expect(screen.getByText('0')).toBeInTheDocument();
      frame(450);
      const mid = Number(screen.getByText(/\d+/).textContent);
      expect(mid).toBeGreaterThan(5);
      expect(mid).toBeLessThan(10);
      frame(450);
      expect(screen.getByText('10')).toBeInTheDocument();
      unmount();
    } finally {
      MotionGlobalConfig.skipAnimations = true;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
