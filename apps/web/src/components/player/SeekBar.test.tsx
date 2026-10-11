import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SeekBar, type SeekBarProps } from './SeekBar';

function renderBar(props: Partial<SeekBarProps> = {}) {
  const onSeek = vi.fn();
  const utils = render(
    <SeekBar currentMs={30_000} durationMs={100_000} buffered={[]} marks={[]} interactive onSeek={onSeek} {...props} />,
  );
  return { ...utils, onSeek };
}

/** jsdom no maqueta: fijamos una pista de 200 px desde x = 100. */
function mockRect(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({ left: 100, width: 200, top: 0, height: 8, right: 300, bottom: 8, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;
}

describe('SeekBar — slider', () => {
  it('expone role slider con valores y texto accesibles', () => {
    renderBar();
    const slider = screen.getByRole('slider', { name: 'Buscar posición' });
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '100000');
    expect(slider).toHaveAttribute('aria-valuenow', '30000');
    expect(slider).toHaveAttribute('aria-valuetext', '0:30 de 1:40');
    expect(slider).toHaveAttribute('tabindex', '0');
  });

  it.each([
    ['ArrowRight', 35_000],
    ['ArrowUp', 35_000],
    ['ArrowLeft', 25_000],
    ['ArrowDown', 25_000],
    ['PageUp', 60_000],
    ['PageDown', 0],
    ['Home', 0],
    ['End', 100_000],
  ])('%s mueve y confirma al soltar la tecla', (key, expected) => {
    const { onSeek } = renderBar();
    const slider = screen.getByRole('slider');
    const ev = fireEvent.keyDown(slider, { key });
    expect(ev).toBe(false); // preventDefault: el atajo global no la procesa
    expect(slider).toHaveAttribute('aria-valuenow', String(expected));
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.keyUp(slider, { key });
    expect(onSeek).toHaveBeenCalledWith(expected);
  });

  it('teclas repetidas acumulan antes de confirmar', () => {
    const { onSeek } = renderBar();
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(40_000);
  });

  it('otras teclas no hacen nada', () => {
    const { onSeek } = renderBar();
    const slider = screen.getByRole('slider');
    expect(fireEvent.keyDown(slider, { key: 'a' })).toBe(true);
    fireEvent.keyUp(slider, { key: 'a' });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('click y arrastre con puntero confirman al soltar', () => {
    const { onSeek } = renderBar();
    const slider = screen.getByRole('slider');
    mockRect(slider);
    fireEvent.pointerDown(slider, { clientX: 150 });
    expect(slider).toHaveAttribute('aria-valuenow', '25000');
    fireEvent.pointerMove(slider, { clientX: 250 });
    expect(slider).toHaveAttribute('aria-valuenow', '75000');
    fireEvent.pointerUp(slider, { clientX: 250 });
    expect(onSeek).toHaveBeenCalledWith(75_000);
    // Fuera de la pista se acota.
    fireEvent.pointerDown(slider, { clientX: 999 });
    fireEvent.pointerUp(slider);
    expect(onSeek).toHaveBeenLastCalledWith(100_000);
  });

  it('muestra el tiempo bajo el cursor y lo oculta al salir', () => {
    renderBar();
    const slider = screen.getByRole('slider');
    mockRect(slider);
    fireEvent.pointerMove(slider, { clientX: 200 });
    expect(screen.getByTestId('seek-hover')).toHaveTextContent('0:50');
    fireEvent.pointerLeave(slider);
    expect(screen.queryByTestId('seek-hover')).not.toBeInTheDocument();
  });

  it('deshabilitado ignora teclado y puntero', () => {
    const { onSeek } = renderBar({ disabled: true });
    const slider = screen.getByRole('slider');
    mockRect(slider);
    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(slider).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.keyUp(slider, { key: 'End' });
    fireEvent.pointerDown(slider, { clientX: 200 });
    fireEvent.pointerUp(slider);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('pista sin ancho (sin layout) se trata como 0', () => {
    const { onSeek } = renderBar();
    const slider = screen.getByRole('slider');
    fireEvent.pointerDown(slider, { clientX: 50 });
    fireEvent.pointerUp(slider);
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it('usa pointer capture si el navegador lo soporta', () => {
    renderBar();
    const slider = screen.getByRole('slider');
    const capture = vi.fn();
    slider.setPointerCapture = capture;
    fireEvent.pointerDown(slider, { clientX: 0, pointerId: 7 });
    expect(capture).toHaveBeenCalled();
  });
});

describe('SeekBar — búfer y marcadores', () => {
  it('dibuja los rangos en búfer y los saltos del host', () => {
    renderBar({ buffered: [[0, 50_000], [60_000, 80_000]], marks: [12_000, 70_000] });
    expect(screen.getAllByTestId('seek-buffered')).toHaveLength(2);
    expect(screen.getAllByTestId('seek-buffered')[1]).toHaveStyle({ left: '60%', width: '20%' });
    expect(screen.getAllByTestId('seek-mark')).toHaveLength(2);
    expect(screen.getByText('Saltos recientes del host: 0:12, 1:10')).toHaveClass('sr-only');
  });

  it('sin duración no dibuja nada fuera de rango', () => {
    renderBar({ durationMs: 0, buffered: [[0, 1]], marks: [5] });
    expect(screen.queryAllByTestId('seek-buffered')).toHaveLength(0);
    expect(screen.queryAllByTestId('seek-mark')).toHaveLength(0);
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '0:30 de 0:00');
  });
});

describe('SeekBar — solo lectura', () => {
  it('participante ve una barra de progreso sin interacción', () => {
    const { onSeek } = renderBar({ interactive: false });
    const bar = screen.getByRole('progressbar', { name: 'Progreso' });
    expect(bar).toHaveAttribute('aria-valuenow', '30');
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    mockRect(bar);
    fireEvent.pointerDown(bar, { clientX: 200 });
    fireEvent.pointerUp(bar);
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerMove(bar, { clientX: 200 });
    expect(screen.getByTestId('seek-hover')).toHaveTextContent('0:50');
  });
});
