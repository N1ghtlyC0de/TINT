import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import App from './App';
import { apiFetch } from './lib/api';

vi.mock('firebase/auth', () => ({
  signInWithPopup: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));

// Evita inicializar Firebase real en tests.
vi.mock('./lib/firebase', () => ({
  auth: {},
  app: {},
}));

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});

describe('App', () => {
  it('redirige a /login por defecto', () => {
    render(<App />);
    expect(screen.getByText('Iniciar sesión con Google')).toBeInTheDocument();
  });

  it('expone /test-me sin sesión (ruta oculta solo por URL)', async () => {
    window.history.pushState({}, '', '/test-me');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: /Cuánto sabes de TINT/ })).toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('/rooms/:id/analytics exige sesión de host', async () => {
    window.history.pushState({}, '', '/rooms/r1/analytics');
    render(<App />);
    expect(await screen.findByText('Iniciar sesión con Google')).toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('/rooms/:id/analytics carga la página diferida con sesión', async () => {
    localStorage.setItem('tint_token', 'host');
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));
    window.history.pushState({}, '', '/rooms/r1/analytics');
    render(<App />);
    expect(await screen.findByText('Cargando analítica…')).toBeInTheDocument();
    localStorage.clear();
    window.history.pushState({}, '', '/');
  });
});
