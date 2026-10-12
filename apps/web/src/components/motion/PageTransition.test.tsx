import { render, screen } from '@testing-library/react';
import { PageTransition } from './PageTransition';

describe('PageTransition', () => {
  it('renderiza a sus hijos', () => {
    render(
      <PageTransition>
        <p>Vista</p>
      </PageTransition>,
    );
    expect(screen.getByText('Vista')).toBeInTheDocument();
  });
});
