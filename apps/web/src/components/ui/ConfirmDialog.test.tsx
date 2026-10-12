import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { useConfirm } from './ConfirmDialog';

function Harness() {
  const { confirm, dialog } = useConfirm();
  const [result, setResult] = useState('');
  return (
    <>
      <button
        onClick={async () =>
          setResult(
            String(
              await confirm({
                title: '¿Eliminar la sala?',
                body: 'Sus links dejarán de funcionar.',
                confirmLabel: 'Eliminar',
                tone: 'danger',
              }),
            ),
          )
        }
      >
        Abrir
      </button>
      <p>resultado:{result}</p>
      {dialog}
    </>
  );
}

describe('useConfirm', () => {
  it('abre un alertdialog modal con el foco en Cancelar', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('Abrir'));
    const dialog = screen.getByRole('alertdialog', { name: '¿Eliminar la sala?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Sus links dejarán de funcionar.');
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });

  it('resuelve true al confirmar y cierra el diálogo', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('Abrir'));
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByText('resultado:true')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('resuelve false al cancelar, con Escape o al pulsar el fondo', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('Abrir'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('resultado:false')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Abrir'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByText('Abrir'));
    await userEvent.click(screen.getByTestId('confirm-backdrop'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByText('resultado:false')).toBeInTheDocument();
  });

  it('atrapa el foco con Tab dentro del diálogo', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('Abrir'));
    const cancel = screen.getByRole('button', { name: 'Cancelar' });
    const ok = screen.getByRole('button', { name: 'Eliminar' });
    await userEvent.tab();
    expect(ok).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(ok).toHaveFocus();
  });

  it('devuelve el foco al elemento que lo abrió', async () => {
    render(<Harness />);
    const opener = screen.getByText('Abrir');
    await userEvent.click(opener);
    await act(async () => {
      await userEvent.keyboard('{Escape}');
    });
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
