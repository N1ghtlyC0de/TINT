import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlayerShortcuts, type PlayerShortcutHandlers } from './usePlayerShortcuts';

function setup(enabled = true) {
  const handlers: PlayerShortcutHandlers = {
    onTogglePlay: vi.fn(),
    onSeekBy: vi.fn(),
    onRateStep: vi.fn(),
    onToggleHelp: vi.fn(),
  };
  const hook = renderHook((p: { enabled: boolean }) => usePlayerShortcuts(p.enabled, handlers), {
    initialProps: { enabled },
  });
  return { ...hook, handlers };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('usePlayerShortcuts', () => {
  it.each([
    [' ', 'onTogglePlay', undefined],
    ['k', 'onTogglePlay', undefined],
    ['K', 'onTogglePlay', undefined],
    ['ArrowLeft', 'onSeekBy', -10_000],
    ['j', 'onSeekBy', -10_000],
    ['ArrowRight', 'onSeekBy', 10_000],
    ['l', 'onSeekBy', 10_000],
    ['[', 'onRateStep', -1],
    [']', 'onRateStep', 1],
    ['?', 'onToggleHelp', undefined],
  ] as const)('%j → %s', (key, handler, arg) => {
    const { handlers } = setup();
    const notPrevented = fireEvent.keyDown(document.body, { key });
    expect(notPrevented).toBe(false);
    if (arg === undefined) expect(handlers[handler]).toHaveBeenCalledWith();
    else expect(handlers[handler]).toHaveBeenCalledWith(arg);
  });

  it('desactivado no hace nada', () => {
    const { handlers } = setup(false);
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
  });

  it('se desactiva al cambiar enabled y se limpia al desmontar', () => {
    const { handlers, rerender, unmount } = setup(true);
    rerender({ enabled: false });
    fireEvent.keyDown(document.body, { key: 'k' });
    unmount();
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
  });

  it.each(['input', 'textarea', 'select'])('ignora atajos con el foco en %s', (tag) => {
    const { handlers } = setup();
    const el = document.createElement(tag);
    document.body.appendChild(el);
    fireEvent.keyDown(el, { key: 'k' });
    fireEvent.keyDown(el, { key: '?' });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
    expect(handlers.onToggleHelp).not.toHaveBeenCalled();
  });

  it('ignora contentEditable', () => {
    const { handlers } = setup();
    const el = document.createElement('div');
    el.contentEditable = 'true';
    document.body.appendChild(el);
    fireEvent.keyDown(el, { key: 'k' });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
  });

  it('Espacio sobre un botón activa el botón, no el atajo', () => {
    const { handlers } = setup();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    fireEvent.keyDown(btn, { key: ' ' });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
    fireEvent.keyDown(btn, { key: 'k' });
    expect(handlers.onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it('ignora modificadores, teclas desconocidas y eventos ya atendidos', () => {
    const { handlers } = setup();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'l', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'j', altKey: true });
    expect(fireEvent.keyDown(document.body, { key: 'x' })).toBe(true);
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.addEventListener('keydown', (e) => e.preventDefault());
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(handlers.onTogglePlay).not.toHaveBeenCalled();
    expect(handlers.onSeekBy).not.toHaveBeenCalled();
  });
});
