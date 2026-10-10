import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { vi, beforeEach } from 'vitest';
import WatchRoom from './WatchRoom';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApi = vi.mocked(apiFetch);

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedApi.mockRejectedValue(new Error('offline'));
});

describe('WatchRoom chat local', () => {
  it('envia un mensaje y lo muestra', async () => {
    renderWatch();
    await userEvent.type(screen.getByPlaceholderText('Escribe un mensaje'), 'Hola grupo');
    await userEvent.click(screen.getByText('Enviar'));
    expect(await screen.findByText('Hola grupo')).toBeInTheDocument();
  });
});
