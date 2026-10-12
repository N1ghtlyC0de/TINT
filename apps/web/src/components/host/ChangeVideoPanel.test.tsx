import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from '../../lib/api';
import { MockXhr } from '../../test/mockXhr';
import { ChangeVideoPanel } from './ChangeVideoPanel';

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

const video = new File(['0123456789'], 'peli.mp4', { type: 'video/mp4' });

const ticket = {
  videoId: 'v-1',
  uploadUrl: 'https://minio/tint/v-1/source.mp4?X-Amz-Signature=s',
  storageKey: 'v-1/source.mp4',
  expiresAt: '2099-01-01T00:00:00Z',
  headers: { 'Content-Type': 'video/mp4' },
};

/** Simula identity-api: pedir subida y confirmarla; el resto falla. */
function routeUploads(overrides: { request?: () => Promise<unknown>; complete?: () => Promise<unknown> } = {}) {
  mockedApiFetch.mockImplementation(((path: string) => {
    if (path.endsWith('/media/uploads')) return overrides.request?.() ?? Promise.resolve(ticket);
    if (path.endsWith('/complete')) {
      return overrides.complete?.() ?? Promise.resolve({ mediaId: 'v-1', mediaKey: 'v-1/source.mp4', status: 'pending' });
    }
    return Promise.reject(new Error(`ruta no simulada ${path}`));
  }) as typeof apiFetch);
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  MockXhr.reset();
  vi.stubGlobal('XMLHttpRequest', MockXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openPanel() {
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
  return screen.getByLabelText('Archivo de vídeo');
}

/** Elige un archivo, pulsa Subir y espera a que arranque el PUT a MinIO. */
async function startUpload(file: File = video) {
  await userEvent.upload(await openPanel(), file);
  await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
  await waitFor(() => expect(MockXhr.instances).toHaveLength(1));
  return MockXhr.last();
}

async function openKeyForm() {
  await userEvent.click(screen.getByRole('button', { name: 'Cambiar vídeo' }));
  await userEvent.click(screen.getByText('Usar un archivo ya subido (clave del bucket)'));
  return screen.getByLabelText('Clave del objeto en MinIO');
}

describe('ChangeVideoPanel — subida', () => {
  it('se despliega con aria-expanded, enfoca el selector y se cierra con Escape', async () => {
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const toggle = screen.getByRole('button', { name: 'Cambiar vídeo' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const input = await openPanel();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'video/*');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Archivo de vídeo')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('el botón Cerrar pliega el panel', async () => {
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByLabelText('Archivo de vídeo')).not.toBeInTheDocument();
  });

  it('sube a MinIO con progreso, confirma y avisa a la sala con el mediaId', async () => {
    routeUploads();
    const onMediaAssigned = vi.fn(() => true);
    render(<ChangeVideoPanel roomId="r 1" onMediaAssigned={onMediaAssigned} />);
    const input = await openPanel();
    expect(screen.getByRole('button', { name: 'Subir' })).toBeDisabled();
    await userEvent.upload(input, video);
    expect(screen.getByText(/peli\.mp4/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Subir' }));

    expect(mockedApiFetch).toHaveBeenCalledWith(
      '/rooms/r%201/media/uploads',
      { method: 'POST', body: JSON.stringify({ filename: 'peli.mp4', contentType: 'video/mp4', sizeBytes: 10 }) },
      'host',
    );
    await waitFor(() => expect(MockXhr.instances).toHaveLength(1));
    const xhr = MockXhr.last();
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(ticket.uploadUrl);
    expect(xhr.headers).toEqual({ 'Content-Type': 'video/mp4' });
    expect(xhr.body).toBe(video);

    const bar = screen.getByRole('progressbar', { name: 'Progreso de subida' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    act(() => xhr.progress(42, 100));
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('Subiendo… 42 %')).toBeInTheDocument();
    expect(screen.getByLabelText('Archivo de vídeo')).toBeDisabled();

    act(() => xhr.respond(200));
    await waitFor(() => expect(onMediaAssigned).toHaveBeenCalledWith('v-1'));
    expect(mockedApiFetch).toHaveBeenCalledWith('/rooms/r%201/media/uploads/v-1/complete', { method: 'POST' }, 'host');
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('muestra "Confirmando…" mientras identity-api registra la subida', async () => {
    let resolveComplete!: (v: unknown) => void;
    routeUploads({ complete: () => new Promise((r) => (resolveComplete = r)) });
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    act(() => xhr.respond(200));
    expect(await screen.findByText(/Confirmando la subida/)).toBeInTheDocument();
    await act(async () => resolveComplete({ mediaId: 'v-1', mediaKey: 'k', status: 'pending' }));
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos');
  });

  it('Cancelar aborta el PUT y permite volver a subir', async () => {
    routeUploads();
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar subida' }));
    expect(xhr.aborted).toBe(true);
    expect(await screen.findByText('Subida cancelada.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/complete'), expect.anything(), 'host');
    expect(screen.getByRole('button', { name: 'Subir' })).toBeEnabled();
  });

  it('aborta la subida en curso si el panel se desmonta', async () => {
    routeUploads();
    const { unmount } = render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    unmount();
    expect(xhr.aborted).toBe(true);
  });

  it('rechaza archivos que no son vídeo sin llamar a identity-api', async () => {
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const input = await openPanel();
    fireEvent.change(input, { target: { files: [new File(['x'], 'notas.txt', { type: 'text/plain' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent(/no es un vídeo/i);
    expect(screen.getByRole('button', { name: 'Subir' })).toBeDisabled();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('413 → el archivo supera el tamaño máximo', async () => {
    routeUploads({ request: () => Promise.reject(new ApiError(413, 'File too large')) });
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await userEvent.upload(await openPanel(), video);
    await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El archivo supera el tamaño máximo');
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('409 al confirmar → la subida no llegó; Subir reintenta todo el flujo', async () => {
    routeUploads({ complete: () => Promise.reject(new ApiError(409, 'Upload missing')) });
    const onMediaAssigned = vi.fn(() => true);
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={onMediaAssigned} />);
    const xhr = await startUpload();
    act(() => xhr.respond(200));
    expect(await screen.findByRole('alert')).toHaveTextContent('La subida no llegó al almacenamiento; reintenta');
    expect(onMediaAssigned).not.toHaveBeenCalled();

    routeUploads();
    await userEvent.click(screen.getByRole('button', { name: 'Subir' }));
    await waitFor(() => expect(MockXhr.instances).toHaveLength(2));
    act(() => MockXhr.last().respond(200));
    await waitFor(() => expect(onMediaAssigned).toHaveBeenCalledWith('v-1'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('error de MinIO en el PUT se muestra legible', async () => {
    routeUploads();
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    const xhr = await startUpload();
    act(() => xhr.respond(403));
    expect(await screen.findByRole('alert')).toHaveTextContent(/almacenamiento rechazó/);
  });

  it('si no se pudo enviar LOAD, avisa y permite reintentar el aviso', async () => {
    routeUploads();
    const onMediaAssigned = vi.fn(() => false);
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={onMediaAssigned} />);
    const xhr = await startUpload();
    act(() => xhr.respond(200));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo avisar a la sala/i);
    const retry = screen.getByRole('button', { name: 'Avisar a la sala' });
    await userEvent.click(retry);
    expect(onMediaAssigned).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    onMediaAssigned.mockReturnValue(true);
    await userEvent.click(retry);
    expect(onMediaAssigned).toHaveBeenLastCalledWith('v-1');
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos');
    expect(screen.queryByRole('button', { name: 'Avisar a la sala' })).not.toBeInTheDocument();
  });
});

describe('ChangeVideoPanel — clave del bucket (secundaria)', () => {
  it('asigna el vídeo con PUT y avisa a la sala con el mediaId devuelto', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'm-7', mediaKey: 'pelis/a.mp4' });
    const onMediaAssigned = vi.fn(() => true);
    render(<ChangeVideoPanel roomId="r 1" onMediaAssigned={onMediaAssigned} />);
    const input = await openKeyForm();
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
    expect(screen.getByRole('status')).toHaveTextContent('Vídeo cargado para todos');
    expect(input).toHaveValue('');
  });

  it('avisa si el vídeo se asignó pero no se pudo enviar LOAD', async () => {
    mockedApiFetch.mockResolvedValue({ mediaId: 'm-7' });
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => false} />);
    await userEvent.type(await openKeyForm(), 'k');
    await userEvent.click(screen.getByRole('button', { name: 'Asignar y cargar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo avisar/i);
  });

  it('muestra el error de identity-api', async () => {
    mockedApiFetch.mockRejectedValueOnce(new ApiError(404, 'objeto no encontrado'));
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await userEvent.type(await openKeyForm(), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Asignar y cargar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('objeto no encontrado');
  });

  it('error genérico si no es ApiError', async () => {
    mockedApiFetch.mockRejectedValueOnce(new TypeError('red'));
    render(<ChangeVideoPanel roomId="r1" onMediaAssigned={() => true} />);
    await userEvent.type(await openKeyForm(), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Asignar y cargar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo asignar/i);
  });
});
