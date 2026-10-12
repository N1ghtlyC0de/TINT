import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { Button, ButtonLink } from './Button';

describe('Button', () => {
  it('renderiza con label en una linea y maneja click', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Crear sala</Button>);
    const btn = screen.getByRole('button', { name: 'Crear sala' });
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('el primario lleva el brillo cálido y el ghost es de vidrio', () => {
    render(
      <>
        <Button>Uno</Button>
        <Button variant="ghost">Dos</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Uno' })).toHaveClass('bg-accent-sheen');
    expect(screen.getByRole('button', { name: 'Dos' })).toHaveClass('tint-glass');
  });

  it('respeta disabled', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Nada</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Nada' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('ButtonLink', () => {
  it('es un enlace con forma de botón y variante', () => {
    render(
      <MemoryRouter>
        <ButtonLink to="/rooms/new">Crear sala</ButtonLink>
        <ButtonLink to="/x" variant="quiet" size="sm" className="extra">Gestionar</ButtonLink>
      </MemoryRouter>,
    );
    const primary = screen.getByRole('link', { name: 'Crear sala' });
    expect(primary).toHaveAttribute('href', '/rooms/new');
    expect(primary).toHaveClass('rounded-full', 'bg-accent-sheen');
    const quiet = screen.getByRole('link', { name: 'Gestionar' });
    expect(quiet).toHaveClass('extra', 'text-[13px]');
    expect(quiet).not.toHaveClass('bg-accent-sheen');
  });
});
