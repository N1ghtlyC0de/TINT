import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostControlBar, VOLUME_SEND_DEBOUNCE_MS, type HostControlBarProps } from './HostControlBar';
import type { PlaybackQuality } from '../../lib/quality';

const QUALITIES: PlaybackQuality[] = [
  { id: 'source', label: 'Original', url: 's' },
  { id: '720p', label: '720p', url: 'h' },
];

function renderBar(over: Partial<HostControlBarProps> = {}) {
  const props: HostControlBarProps = {
    connected: true,
    volume: 0.8,
    onVolumeChange: vi.fn(),
    quality: 'auto',
    qualities: QUALITIES,
    onQualityChange: vi.fn(),
    rate: 1,
    onRateChange: vi.fn(),
    ...over,
  };
  const utils = render(<HostControlBar {...props} />);
  return { ...utils, props, rerenderWith: (o: Partial<HostControlBarProps>) => utils.rerender(<HostControlBar {...props} {...o} />) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HostControlBar — volumen', () => {
  it('muestra el volumen maestro en porcentaje', () => {
    renderBar();
    const slider = screen.getByRole('slider', { name: 'Volumen de la sala' });
    expect(slider).toHaveValue('80');
    expect(slider).toHaveAttribute('aria-valuetext', '80 %');
  });

  it('envía VOLUME con debounce mientras se arrastra', () => {
    vi.useFakeTimers();
    const { props } = renderBar();
    const slider = screen.getByRole('slider', { name: 'Volumen de la sala' });
    fireEvent.change(slider, { target: { value: '60' } });
    fireEvent.change(slider, { target: { value: '40' } });
    expect(slider).toHaveValue('40');
    expect(props.onVolumeChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(VOLUME_SEND_DEBOUNCE_MS));
    expect(props.onVolumeChange).toHaveBeenCalledTimes(1);
    expect(props.onVolumeChange).toHaveBeenCalledWith(0.4);
  });

  it('el borrador se descarta cuando llega el nuevo maestro', () => {
    vi.useFakeTimers();
    const { rerenderWith } = renderBar();
    const slider = screen.getByRole('slider', { name: 'Volumen de la sala' });
    fireEvent.change(slider, { target: { value: '40' } });
    act(() => vi.advanceTimersByTime(VOLUME_SEND_DEBOUNCE_MS));
    rerenderWith({ volume: 0.3 });
    expect(slider).toHaveValue('30');
  });

  it('silenciar envía 0 y reactivar recupera el último volumen', () => {
    const { props, rerenderWith } = renderBar();
    const mute = screen.getByRole('button', { name: 'Silenciar a la sala' });
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(mute);
    expect(props.onVolumeChange).toHaveBeenLastCalledWith(0);
    rerenderWith({ volume: 0 });
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(mute);
    expect(props.onVolumeChange).toHaveBeenLastCalledWith(0.8);
  });

  it('reactivar sin volumen previo vuelve al 100 %', () => {
    const { props } = renderBar({ volume: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Silenciar a la sala' }));
    expect(props.onVolumeChange).toHaveBeenLastCalledWith(1);
  });

  it('desmontar con un envío pendiente no lo dispara', () => {
    vi.useFakeTimers();
    const { props, unmount } = renderBar();
    fireEvent.change(screen.getByRole('slider', { name: 'Volumen de la sala' }), { target: { value: '10' } });
    unmount();
    act(() => vi.advanceTimersByTime(VOLUME_SEND_DEBOUNCE_MS));
    expect(props.onVolumeChange).not.toHaveBeenCalled();
  });
});

describe('HostControlBar — calidad y velocidad', () => {
  it('ofrece Auto más las calidades disponibles', () => {
    const { props } = renderBar();
    const select = screen.getByRole('combobox', { name: 'Calidad' });
    expect(select).toHaveValue('auto');
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['Auto', 'Original', '720p']);
    fireEvent.change(select, { target: { value: '720p' } });
    expect(props.onQualityChange).toHaveBeenCalledWith('720p');
  });

  it('muestra la calidad maestra aunque no esté en la lista', () => {
    renderBar({ quality: '360p' });
    expect(screen.getByRole('combobox', { name: 'Calidad' })).toHaveValue('360p');
  });

  it('elegir la misma calidad no envía nada', () => {
    const { props } = renderBar({ quality: '720p' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Calidad' }), { target: { value: '720p' } });
    expect(props.onQualityChange).not.toHaveBeenCalled();
  });

  it('selector de velocidad con atajos', () => {
    const { props } = renderBar();
    const select = screen.getByRole('combobox', { name: 'Velocidad' });
    expect(select).toHaveAttribute('aria-keyshortcuts', '[ ]');
    fireEvent.change(select, { target: { value: '1.5' } });
    expect(props.onRateChange).toHaveBeenCalledWith(1.5);
  });

  it('desconectado deshabilita los controles', () => {
    renderBar({ connected: false });
    expect(screen.getByRole('slider', { name: 'Volumen de la sala' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Calidad' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Velocidad' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Silenciar a la sala' })).toBeDisabled();
  });
});

describe('HostControlBar — láser y encuestas', () => {
  it('sin manejadores no muestra los botones', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: 'Puntero láser' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Crear encuesta' })).not.toBeInTheDocument();
  });

  it('alterna el láser y abre el creador de encuestas', () => {
    const onToggleLaser = vi.fn();
    const onOpenPoll = vi.fn();
    renderBar({ laserOn: true, onToggleLaser, onOpenPoll });
    const laser = screen.getByRole('button', { name: 'Puntero láser' });
    expect(laser).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(laser);
    expect(onToggleLaser).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Crear encuesta' }));
    expect(onOpenPoll).toHaveBeenCalled();
  });
});

describe('HostControlBar — atajo L del láser', () => {
  it('L alterna el láser y anula el atajo de avance del reproductor', () => {
    const onToggleLaser = vi.fn();
    renderBar({ onToggleLaser });
    expect(screen.getByRole('button', { name: 'Puntero láser' })).toHaveAttribute('aria-keyshortcuts', 'L');
    const lower = new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(lower);
    });
    expect(onToggleLaser).toHaveBeenCalledTimes(1);
    // preventDefault: usePlayerShortcuts ignora la tecla ya atendida (no avanza 10 s).
    expect(lower.defaultPrevented).toBe(true);
    fireEvent.keyDown(document.body, { key: 'L' });
    expect(onToggleLaser).toHaveBeenCalledTimes(2);
  });

  it('ignora L al escribir en un campo, con modificadores o si ya se atendió', () => {
    const onToggleLaser = vi.fn();
    renderBar({ onToggleLaser });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'l' });
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.appendChild(editable);
    fireEvent.keyDown(editable, { key: 'L' });
    fireEvent.keyDown(document.body, { key: 'l', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'l', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'l', altKey: true });
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(onToggleLaser).not.toHaveBeenCalled();
    input.remove();
    editable.remove();
  });

  it('sin láser disponible no intercepta L', () => {
    renderBar();
    const event = new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('desmontar quita el atajo', () => {
    const onToggleLaser = vi.fn();
    const { unmount } = renderBar({ onToggleLaser });
    unmount();
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(onToggleLaser).not.toHaveBeenCalled();
  });
});
