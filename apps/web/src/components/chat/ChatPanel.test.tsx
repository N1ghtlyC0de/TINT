import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from '../../lib/api';
import type { SocialChatItem } from '../../hooks/useSocialSocket';
import { ChatPanel, type ChatPanelProps } from './ChatPanel';

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockedApiFetch = vi.mocked(apiFetch);

const msg = (event_id: string, user_id: string, nick: string, text: string, over: Record<string, unknown> = {}): SocialChatItem => ({
  event_id,
  type: 'chat_message',
  room_id: 'r1',
  user_id,
  nick,
  text,
  occurred_at: '2026-10-10T10:05:00Z',
  received_at: '2026-10-10T10:05:01Z',
  ...over,
});

const messages: SocialChatItem[] = [
  msg('m1', 'host-1', 'Host', 'Bienvenidos'),
  msg('m2', 'guest:ana', 'Ana', 'Hola grupo'),
  msg('m3', 'guest:luis', 'Luis', 'El asesino es el mayordomo', { spoiler: true }),
];

function renderPanel(over: Partial<ChatPanelProps> = {}) {
  const props: ChatPanelProps = {
    roomId: 'r1',
    messages,
    identity: { sub: 'host-1', nick: 'Host', isGuest: false },
    isHost: true,
    send: vi.fn(() => true),
    chatSettings: { slow_mode_s: 0, muted_user_ids: [] },
    cooldownUntil: null,
    lastError: null,
    onSetSlowMode: vi.fn(() => true),
    onMuteUser: vi.fn(() => true),
    ...over,
  };
  return { props, ...render(<ChatPanel {...props} />) };
}

const guestIdentity = { sub: 'guest:ana', nick: 'Ana', isGuest: true };

beforeEach(() => {
  mockedApiFetch.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('ChatPanel — envío y spoilers', () => {
  it('envía el texto y limpia el campo', () => {
    const { props } = renderPanel({ isHost: false, identity: guestIdentity });
    const input = screen.getByLabelText('Escribe un mensaje');
    fireEvent.change(input, { target: { value: 'Buenas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(props.send).toHaveBeenCalledWith('Buenas');
    expect(input).toHaveValue('');
  });

  it('con "Spoiler" activo el mensaje se envía marcado y el botón se apaga', () => {
    const { props } = renderPanel({ isHost: false, identity: guestIdentity });
    const toggle = screen.getByRole('button', { name: 'Spoiler' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText('Escribe un mensaje'), { target: { value: 'muere' } });
    fireEvent.submit(screen.getByLabelText('Escribe un mensaje'));
    expect(props.send).toHaveBeenCalledWith('muere', { spoiler: true });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('el texto vacío no se envía', () => {
    const { props } = renderPanel();
    fireEvent.submit(screen.getByLabelText('Escribe un mensaje'));
    expect(props.send).not.toHaveBeenCalled();
  });

  it('el spoiler se oculta, se revela con foco de teclado y el toque lo alterna', () => {
    renderPanel({ isHost: false, identity: guestIdentity });
    const spoiler = screen.getByRole('button', { name: 'Spoiler oculto, enfoca para leer' });
    expect(spoiler.className).toContain('blur');
    expect(spoiler.className).toContain('hover:blur-none');
    fireEvent.focus(spoiler);
    expect(spoiler).not.toHaveAttribute('aria-label');
    expect(spoiler).toHaveTextContent('El asesino es el mayordomo');
    fireEvent.blur(spoiler);
    expect(spoiler).toHaveAttribute('aria-label', 'Spoiler oculto, enfoca para leer');
    // Toque: pointerdown + focus + click alterna sin que el foco lo cuente.
    fireEvent.pointerDown(spoiler);
    fireEvent.focus(spoiler);
    fireEvent.click(spoiler);
    expect(spoiler).toHaveAttribute('aria-pressed', 'true');
    expect(spoiler.className).not.toMatch(/(^| )blur-/);
    fireEvent.click(spoiler);
    expect(spoiler).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(spoiler, { key: 'Enter' });
    expect(spoiler).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(spoiler, { key: ' ' });
    expect(spoiler).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(spoiler, { key: 'a' });
    expect(spoiler).toHaveAttribute('aria-pressed', 'false');
  });

  it('el estado vacío invita a saludar', () => {
    renderPanel({ messages: [] });
    expect(screen.getByText(/Sin mensajes aún/)).toBeInTheDocument();
  });
});

describe('ChatPanel — modo lento', () => {
  it('el host elige el modo lento', () => {
    const { props } = renderPanel();
    const select = screen.getByLabelText('Modo lento');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Apagado', '5 s', '10 s', '30 s', '1 min']);
    fireEvent.change(select, { target: { value: '30' } });
    expect(props.onSetSlowMode).toHaveBeenCalledWith(30);
  });

  it('el invitado no tiene el selector y ve el aviso con cuenta regresiva en Enviar', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    renderPanel({
      isHost: false,
      identity: guestIdentity,
      chatSettings: { slow_mode_s: 10, muted_user_ids: [] },
      cooldownUntil: 14_000,
    });
    expect(screen.queryByLabelText('Modo lento')).not.toBeInTheDocument();
    expect(screen.getByText('Modo lento: puedes escribir un mensaje cada 10 s.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Espera 4 s para enviar' });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('4 s');
    act(() => {
      vi.advanceTimersByTime(4_100);
    });
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  });

  it('con 1 min el aviso lo dice en palabras', () => {
    renderPanel({ isHost: false, identity: guestIdentity, chatSettings: { slow_mode_s: 60, muted_user_ids: [] } });
    expect(screen.getByText('Modo lento: puedes escribir un mensaje cada 1 min.')).toBeInTheDocument();
  });

  it('muestra los errores del canal en palabras simples', () => {
    renderPanel({ isHost: false, identity: guestIdentity, lastError: { code: 'SLOW_MODE', retry_after_ms: 3000 } });
    expect(screen.getByRole('alert')).toHaveTextContent(/modo lento/i);
  });

  it('los errores ajenos al chat (trivia, encuestas) no se muestran aquí', () => {
    renderPanel({ lastError: { code: 'POLL_CLOSED' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ChatPanel — silenciado', () => {
  it('el invitado silenciado no puede escribir pero lee el chat', () => {
    renderPanel({ isHost: false, identity: guestIdentity, chatSettings: { slow_mode_s: 0, muted_user_ids: ['guest:ana'] } });
    const input = screen.getByLabelText('Escribe un mensaje');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'El host te silenció; puedes leer el chat');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(screen.getByText('Hola grupo')).toBeInTheDocument();
  });
});

describe('ChatPanel — menú del host', () => {
  it('solo aparece en mensajes ajenos y solo para el host', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Opciones para Host' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Opciones para Ana' })).toBeInTheDocument();
  });

  it('el invitado no ve el menú', () => {
    renderPanel({ isHost: false, identity: guestIdentity });
    expect(screen.queryByRole('button', { name: /Opciones para/ })).not.toBeInTheDocument();
  });

  it('silencia y quita el silencio', () => {
    const { props, rerender } = renderPanel();
    const trigger = screen.getByRole('button', { name: 'Opciones para Ana' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const item = screen.getByRole('menuitem', { name: 'Silenciar' });
    expect(item).toHaveFocus();
    fireEvent.click(item);
    expect(props.onMuteUser).toHaveBeenCalledWith('guest:ana', true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    rerender(<ChatPanel {...props} chatSettings={{ slow_mode_s: 0, muted_user_ids: ['guest:ana'] }} />);
    expect(screen.getByText('Silenciado')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Opciones para Ana' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quitar silencio' }));
    expect(props.onMuteUser).toHaveBeenCalledWith('guest:ana', false);
  });

  it('Escape cierra el menú y devuelve el foco', () => {
    renderPanel();
    const trigger = screen.getByRole('button', { name: 'Opciones para Ana' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('bloquear pide confirmación y llama a POST bans con el sub', async () => {
    mockedApiFetch.mockResolvedValue({ ban: { id: 'b1', nick: 'Ana', createdAt: 'x' } });
    renderPanel({ roomId: 'r 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Opciones para Ana' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bloquear de la sala' }));
    expect(mockedApiFetch).not.toHaveBeenCalled();
    expect(screen.getByText(/¿Bloquear a Ana\?/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Sí, bloquear' });
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/rooms/r%201/bans',
        { method: 'POST', body: JSON.stringify({ sub: 'guest:ana' }) },
        'host',
      ),
    );
    expect(await screen.findByRole('status', { name: 'Moderación' })).toHaveTextContent('Ana fue bloqueado de la sala.');
  });

  it('cancelar el bloqueo no llama a la API; un fallo se muestra simple', async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(500, 'boom'));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Opciones para Ana' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bloquear de la sala' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(mockedApiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Opciones para Ana' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bloquear de la sala' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sí, bloquear' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo bloquear a Ana. Inténtalo de nuevo.');
  });
});
