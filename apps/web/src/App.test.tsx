import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import App from './App';

vi.mock('firebase/auth', () => ({
  signInWithPopup: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));

// Evita inicializar Firebase real en tests.
vi.mock('./lib/firebase', () => ({
  auth: {},
  app: {},
}));

vi.mock('./lib/api', () => ({
  apiFetch: vi.fn(),
}));

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
});
