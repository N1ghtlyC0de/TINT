import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  it('copia el link absoluto al portapapeles y confirma', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton link="/invite/abc123" />);
    await userEvent.click(screen.getByRole('button', { name: /copiar/i }));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/invite/abc123`,
    );
    expect(await screen.findByRole('button', { name: /copiado/i })).toBeInTheDocument();
  });

  it('muestra estado de error si el portapapeles falla', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton link="/invite/abc123" />);
    await userEvent.click(screen.getByRole('button', { name: /copiar/i }));
    expect(await screen.findByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  });
});
