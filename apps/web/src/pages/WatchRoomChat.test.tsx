import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { vi } from 'vitest';
import WatchRoom from './WatchRoom';

const sendMock = vi.fn(() => true);

vi.mock('../hooks/useSocialSocket', () => ({
  useSocialSocket: () => ({
    status: 'open' as const,
    messages: [
      {
        event_id: 'm1',
        type: 'chat_message',
        room_id: 'r1',
        user_id: 'u1',
        nick: 'Ana',
        text: 'Hola grupo',
        occurred_at: 't',
        received_at: 't',
      },
    ],
    send: sendMock,
  }),
}));

function renderWatch() {
  return render(
    <MemoryRouter initialEntries={['/watch/r1']}>
      <Routes>
        <Route path="/watch/:roomId" element={<WatchRoom />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WatchRoom chat en vivo', () => {
  it('muestra el historial del socket y envía por el canal social', async () => {
    renderWatch();
    expect(await screen.findByText('Hola grupo')).toBeInTheDocument();
    expect(screen.getByText('Chat conectado')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('Escribe un mensaje'), 'Buenas');
    await userEvent.click(screen.getByText('Enviar'));
    expect(sendMock).toHaveBeenCalledWith('Buenas');
  });

  it('la lista de mensajes tiene altura acotada con scroll interno', async () => {
    const { container } = renderWatch();
    const list = await screen.findByRole('list');
    // Altura acotada + scroll: la Card no debe crecer con los mensajes.
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('min-h-0');
    expect(list.className).toContain('flex-1');
    const card = list.closest('div');
    expect(card?.className).toContain('h-[560px]');
    expect(container.querySelector('aside')?.className).toContain('min-h-0');
  });
});
