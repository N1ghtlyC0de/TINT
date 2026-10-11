import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { beforeEach } from 'vitest';
import ProtectedRoute from './ProtectedRoute';

beforeEach(() => {
  localStorage.clear();
});

describe('ProtectedRoute', () => {
  it('muestra el contenido si hay token', () => {
    localStorage.setItem('tint_token', 'tok');
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <p>Contenido privado</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Contenido privado')).toBeInTheDocument();
  });

  it('redirige al login si no hay token', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <p>Contenido privado</p>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<p>Página de login</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Página de login')).toBeInTheDocument();
  });

  it('al redirigir conserva la ruta pedida en ?next= para volver tras el login', () => {
    function LoginProbe() {
      const location = useLocation();
      return <p>{`login${location.search}`}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/rooms/r1?tab=links']}>
        <Routes>
          <Route
            path="/rooms/:id"
            element={
              <ProtectedRoute>
                <p>Contenido privado</p>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(`login?next=${encodeURIComponent('/rooms/r1?tab=links')}`)).toBeInTheDocument();
  });
});
