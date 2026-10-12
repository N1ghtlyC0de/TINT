import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RecapScreen } from './RecapScreen';

describe('RecapScreen — qué sigue', () => {
  it('el host puede cancelar la confirmación de terminar (botón o Escape) sin cerrar el modal', () => {
    const onDismiss = vi.fn();
    const onEndRoom = vi.fn(() => Promise.resolve());
    render(<RecapScreen recap={null} onDismiss={onDismiss} isHost onEndRoom={onEndRoom} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminar la sala' }));
    expect(screen.getByRole('button', { name: 'Sí, terminar' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('button', { name: 'Sí, terminar' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Terminar la sala' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Sí, terminar' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Sí, terminar' })).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onEndRoom).not.toHaveBeenCalled();
  });

  it('sin onEndRoom confirmar no hace nada', () => {
    render(<RecapScreen recap={null} onDismiss={vi.fn()} isHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminar la sala' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sí, terminar' }));
    expect(screen.getByRole('button', { name: 'Sí, terminar' })).toBeEnabled();
  });
});
