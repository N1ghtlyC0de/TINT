import { render, screen } from '@testing-library/react';
import { m } from 'framer-motion';
import { MotionProvider } from './MotionProvider';

describe('MotionProvider', () => {
  it('provee las features de animación a los componentes m.*', () => {
    render(
      <MotionProvider>
        <m.p animate={{ opacity: 1 }}>Animado</m.p>
      </MotionProvider>,
    );
    expect(screen.getByText('Animado')).toBeInTheDocument();
  });
});
