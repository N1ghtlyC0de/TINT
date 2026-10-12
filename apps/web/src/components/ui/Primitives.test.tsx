import { render, screen } from '@testing-library/react';
import { Card, Field, ErrorAlert, EmptyState, Skeleton } from './Primitives';

describe('Primitives', () => {
  it('Card renderiza hijos', () => {
    render(<Card><p>Hola card</p></Card>);
    expect(screen.getByText('Hola card')).toBeInTheDocument();
  });

  it('Field muestra helper cuando no hay error', () => {
    render(
      <Field label="Nombre" htmlFor="n" helper="Ayuda">
        <input id="n" />
      </Field>,
    );
    expect(screen.getByText('Nombre')).toBeInTheDocument();
    expect(screen.getByText('Ayuda')).toBeInTheDocument();
  });

  it('Field muestra error con rol alert', () => {
    render(
      <Field label="Nombre" error="Requerido" helper="Ayuda">
        <input />
      </Field>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Requerido');
  });

  it('ErrorAlert retorna null con mensaje vacio y muestra mensaje', () => {
    const { container } = render(<ErrorAlert message="" />);
    expect(container).toBeEmptyDOMElement();
    render(<ErrorAlert message="Fallo" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Fallo');
  });

  it('EmptyState muestra titulo, cuerpo y accion', () => {
    render(<EmptyState title="Vacio" body="Nada aqui" action={<button>Crear</button>} />);
    expect(screen.getByText('Vacio')).toBeInTheDocument();
    expect(screen.getByText('Nada aqui')).toBeInTheDocument();
    expect(screen.getByText('Crear')).toBeInTheDocument();
  });

  it('Skeleton es aria-hidden', () => {
    const { container } = render(<Skeleton className="h-10" />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Input', () => {
  it('es un input translúcido que reenvía props y clases', async () => {
    const { Input } = await import('./Primitives');
    render(<Input aria-label="Nick" className="extra" placeholder="Nick" />);
    const input = screen.getByRole('textbox', { name: 'Nick' });
    expect(input).toHaveClass('rounded-xl', 'extra');
    expect(input).toHaveAttribute('placeholder', 'Nick');
  });

  it('Skeleton usa el shimmer en vez de pulse', async () => {
    const { Skeleton } = await import('./Primitives');
    const { container } = render(<Skeleton className="h-4" />);
    expect(container.firstChild).toHaveClass('tint-shimmer');
    expect(container.firstChild).not.toHaveClass('animate-pulse');
  });
});
