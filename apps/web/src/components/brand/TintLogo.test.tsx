import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TintLogo, TINT_LOGO_COMPACT_BELOW } from './TintLogo';

describe('TintLogo', () => {
  it('es una imagen accesible con nombre "TINT" y el tamaño pedido', () => {
    render(<TintLogo size={40} />);
    const logo = screen.getByRole('img', { name: 'TINT' });
    expect(logo).toHaveAttribute('width', '40');
    expect(logo).toHaveAttribute('height', '40');
    expect(logo).toHaveAttribute('data-variant', 'full');
  });

  it(`por debajo de ${TINT_LOGO_COMPACT_BELOW} px usa la variante simplificada`, () => {
    expect(TINT_LOGO_COMPACT_BELOW).toBe(24);
    render(<TintLogo size={16} label="Inicio de TINT" />);
    const logo = screen.getByRole('img', { name: 'Inicio de TINT' });
    expect(logo).toHaveAttribute('data-variant', 'compact');
  });

  it('24 px ya usa la variante completa', () => {
    render(<TintLogo size={24} />);
    expect(screen.getByRole('img')).toHaveAttribute('data-variant', 'full');
  });

  it('decorativo: oculto para lectores de pantalla', () => {
    const { container } = render(<TintLogo decorative />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '36');
  });

  it('cada instancia usa su propio id de gradiente', () => {
    const { container } = render(
      <>
        <TintLogo />
        <TintLogo size={16} />
      </>,
    );
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const fills = Array.from(container.querySelectorAll('svg')).map((svg) => svg.innerHTML);
    expect(fills[0]).toContain(`url(#${ids[0]})`);
    expect(fills[1]).toContain(`url(#${ids[1]})`);
  });
});
