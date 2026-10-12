import { render } from '@testing-library/react';
import { AmbientBackground } from './AmbientBackground';

describe('AmbientBackground', () => {
  it('es decorativo: oculto a lectores y sin capturar el puntero', () => {
    const { container } = render(<AmbientBackground />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root).toHaveClass('pointer-events-none');
    expect(root.querySelectorAll('[data-orb]').length).toBeGreaterThanOrEqual(2);
  });
});
