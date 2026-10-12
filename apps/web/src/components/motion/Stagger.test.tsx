import { render, screen } from '@testing-library/react';
import { StaggerList, StaggerItem } from './Stagger';

describe('StaggerList', () => {
  it('renderiza una lista con sus elementos y atributos', () => {
    render(
      <StaggerList aria-label="Salas" className="grid">
        <StaggerItem>Uno</StaggerItem>
        <StaggerItem className="x">Dos</StaggerItem>
      </StaggerList>,
    );
    const list = screen.getByRole('list', { name: 'Salas' });
    expect(list).toHaveClass('grid');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Dos')).toHaveClass('x');
  });
});
