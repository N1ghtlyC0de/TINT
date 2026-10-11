import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncQuality } from '../../lib/syncQuality';
import { ReconnectStatus, SyncQualityIndicator } from './SyncStatus';

afterEach(() => vi.useRealTimers());

describe('syncQuality', () => {
  it.each([
    [null, null, 'unknown'],
    [40, null, 'good'],
    [149, 199, 'good'],
    [149, -199, 'good'],
    [150, 0, 'fair'],
    [100, 200, 'fair'],
    [399, -500, 'fair'],
    [400, 0, 'poor'],
    [100, 501, 'poor'],
  ] as const)('rtt %s, drift %s → %s', (rtt, drift, out) => {
    expect(syncQuality(rtt, drift)).toBe(out);
  });
});

describe('SyncQualityIndicator', () => {
  it('muestra el nivel y los números de RTT y desfase', () => {
    render(<SyncQualityIndicator rttMs={42} driftMs={120} />);
    const el = screen.getByTestId('sync-quality');
    expect(el).toHaveAttribute('data-quality', 'good');
    expect(el).toHaveTextContent('Sincronía buena');
    expect(el).toHaveTextContent('RTT 42 ms · desfase +120 ms');
    expect(el).toHaveAttribute('title', 'RTT 42 ms · desfase +120 ms');
  });

  it('amarillo y rojo con textos accesibles', () => {
    const { rerender } = render(<SyncQualityIndicator rttMs={250} driftMs={-300} />);
    expect(screen.getByTestId('sync-quality')).toHaveAttribute('data-quality', 'fair');
    expect(screen.getByText('Sincronía regular')).toBeInTheDocument();
    expect(screen.getByTestId('sync-quality')).toHaveTextContent('desfase −300 ms');
    rerender(<SyncQualityIndicator rttMs={800} driftMs={0} />);
    expect(screen.getByText('Sincronía inestable')).toBeInTheDocument();
    expect(screen.getByTestId('sync-quality')).toHaveTextContent('desfase 0 ms');
  });

  it('sin medidas muestra "Midiendo…"', () => {
    render(<SyncQualityIndicator rttMs={null} driftMs={null} />);
    expect(screen.getByTestId('sync-quality')).toHaveTextContent('Midiendo sincronía…');
  });
});

describe('ReconnectStatus', () => {
  it('conectado → Sincronizado', () => {
    render(<ReconnectStatus connected reconnect={null} />);
    expect(screen.getByText('Sincronizado')).toBeInTheDocument();
  });

  it('sin reintento programado → Conectando…', () => {
    render(<ReconnectStatus connected={false} reconnect={null} />);
    expect(screen.getByText('Conectando…')).toBeInTheDocument();
  });

  it('muestra el intento y una cuenta regresiva', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const nextRetryAt = Date.now() + 4_000;
    render(<ReconnectStatus connected={false} reconnect={{ attempt: 3, nextRetryAt }} />);
    expect(screen.getByTestId('reconnect-countdown')).toHaveTextContent('Reconectando… intento 3 · 4 s');
    expect(screen.getByText('Reconectando, intento 3')).toHaveClass('sr-only');
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId('reconnect-countdown')).toHaveTextContent('intento 3 · 3 s');
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByTestId('reconnect-countdown')).toHaveTextContent(/intento 3$/);
  });
});
