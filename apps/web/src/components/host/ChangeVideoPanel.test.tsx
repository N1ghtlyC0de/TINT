import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from '../../lib/api';
import { ChangeVideoPanel } from './ChangeVideoPanel';

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

beforeEach(() => mockedApiFetch.mockReset());

async function openPanel() {
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
  return screen.getByLabelText('Clave del objeto en MinIO');
}

describe('ChangeVideoPanel', () => {
  it('se despliega con aria-expanded y se cierra con Escape', async () => {
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const toggle = screen.getByRole('button', { name: 'Cambiar vídeo' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const input = await openPanel();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Clave del objeto en MinIO')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('asigna el vídeo con PUT y avisa a la sala con el mediaId devuelto', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'm-7', mediaKey: 'pelis/a.mp4' });
    const onMediaAssigned = vi.fn(() => true);
    render(<ChangeVideoPanel roomId="r 1" onMediaAssigned={onMediaAssigned} />);
    const input = await openPanel();
    const submit = screen.getByRole('button', { name: 'Asignar y cargar' });
    expect(submit).toBeDisabled();
    await userEvent.type(input, '  pelis/a.mp4 ');
    await userEvent.click(submit);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r%201/media',
      { method: 'PUT', body: JSON.stringify({ mediaKey: 'pelis/a.mp4' }) },
      'host',
    );
    await waitFor(() => expect(onMediaAssigned).toHaveBeenCalledWith('m-7'));
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado en la sala');
  });

  it('avisa si el vídeo se asignó pero no se pudo enviar LOAD', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'm-7' });
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => false} />);
    await userEvent.type(await openPanel(), 'k');
    await userEvent.click(screen.getByRole('button', { name: 'Asignar y cargar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo avisar/i);
  });

  it('muestra el error de identity-api', async () => {
    mockedApiFetch.mockRejectedValueOnce(new ApiError(404, 'objeto no encontrado'));
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await userEvent.type(await openPanel(), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Asignar y cargar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('objeto no encontrado');
  });

  it('error genérico si no es ApiError', async () => {
    mockedApiFetch.mockRejectedValueOnce(new TypeError('red'));
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await userEvent.type(await openPanel(), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Asignar y cargar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo asignar/i);
  });
});
