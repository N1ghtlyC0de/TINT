import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElementWidth } from './useElementWidth';

function Probe({ fallback }: { fallback: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(fallback);
  return <div ref={ref}>{`w=${width}`}</div>;
}

type Callback = (entries: Array<{ contentRect: { width: number } }>) => void;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useElementWidth', () => {
  it('sin ResizeObserver (jsdom) usa el ancho de respaldo', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<Probe fallback={640} />);
    expect(screen.getByText('w=640')).toBeInTheDocument();
  });

  it('sigue el ancho observado, ignora 0 y se desconecta al desmontar', () => {
    let callback: Callback = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: Callback) {
          callback = cb;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const { unmount } = render(<Probe fallback={640} />);
    expect(observe).toHaveBeenCalledTimes(1);
    act(() => callback([{ contentRect: { width: 391.6 } }]));
    expect(screen.getByText('w=392')).toBeInTheDocument();
    act(() => callback([{ contentRect: { width: 0 } }]));
    expect(screen.getByText('w=392')).toBeInTheDocument();
    act(() => callback([]));
    expect(screen.getByText('w=392')).toBeInTheDocument();
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
