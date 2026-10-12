import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('renderiza marca, contenido y nav en una sola linea', () => {
    render(
      <MemoryRouter>
        <AppShell actions={<button>Crear sala</button>}>
          <p>Hola</p>
        </AppShell>
      </MemoryRouter>,
    );
    expect(screen.getByText('TINT')).toBeInTheDocument();
    expect(screen.getByText('Hola')).toBeInTheDocument();
    expect(screen.getByText('Crear sala')).toBeInTheDocument();
  });

  it('la marca usa el logo SVG dentro del enlace de inicio', () => {
    render(
      <MemoryRouter>
        <AppShell>
          <p>Hola</p>
        </AppShell>
      </MemoryRouter>,
    );
    const home = screen.getByRole('link', { name: 'TINT inicio' });
    const logo = home.querySelector('svg[data-variant]');
    expect(logo).not.toBeNull();
    // El enlace ya nombra la marca: el logo es decorativo.
    expect(logo).toHaveAttribute('aria-hidden', 'true');
  });
});
