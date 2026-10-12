import { render, screen } from '@testing-library/react';
import { CountUp } from './CountUp';

describe('CountUp', () => {
  it('termina mostrando el valor final con números tabulares', async () => {
    render(<CountUp value={1234} />);
    const el = await screen.findByText('1234');
    expect(el).toHaveClass('tabular-nums');
  });

  it('acepta un formateador', async () => {
    render(<CountUp value={42} format={(n) => `${n} ms`} />);
    expect(await screen.findByText('42 ms')).toBeInTheDocument();
  });

  it('se actualiza cuando cambia el valor', async () => {
    const { rerender } = render(<CountUp value={1} />);
    await screen.findByText('1');
    rerender(<CountUp value={7} />);
    expect(await screen.findByText('7')).toBeInTheDocument();
  });
});
