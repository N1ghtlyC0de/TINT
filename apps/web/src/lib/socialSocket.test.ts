import { describe, expect, it } from 'vitest';
import {
  buildChatSend,
  buildReactionSend,
  buildSocialUrl,
  CHAT_MAX_LENGTH,
  formatChatTime,
  noticeText,
  parseSocialMessage,
  REACTION_EMOJIS,
} from './socialSocket';

describe('socialSocket', () => {
  it('construye la URL con room y token', () => {
    expect(buildSocialUrl('ws://h/ws/social', 'r 1', 'a&b')).toBe(
      'ws://h/ws/social?room_id=r%201&token=a%26b',
    );
  });

  it('arma chat_send con texto recortado y 280 como tope de producto', () => {
    expect(CHAT_MAX_LENGTH).toBe(280);
    const raw = buildChatSend('r1', '  Hola  ');
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe('chat_send');
    expect(parsed.room_id).toBe('r1');
    expect(parsed.text).toBe('Hola');
    expect(typeof parsed.event_id).toBe('string');
    expect(typeof parsed.occurred_at).toBe('string');
  });

  it('parsea history, chat_message y error; ignora resto', () => {
    expect(
      parseSocialMessage('{"type":"history","room_id":"r1","messages":[]}'),
    ).toMatchObject({ type: 'history' });
    expect(
      parseSocialMessage('{"type":"chat_message","text":"hola"}'),
    ).toMatchObject({ type: 'chat_message' });
    expect(parseSocialMessage('{"type":"error","code":"RATE_LIMITED"}')).toMatchObject({
      type: 'error',
    });
    expect(parseSocialMessage('no-json')).toBeNull();
    expect(parseSocialMessage('{"type":"trivia"}')).toBeNull();
    expect(parseSocialMessage('42')).toBeNull();
  });

  it('parsea notice de presencia con kind joined/left', () => {
    expect(
      parseSocialMessage(
        '{"type":"notice","event_id":"n1","room_id":"r1","user_id":"u1","nick":"Pedro","kind":"joined","text":"Pedro entró al chat","occurred_at":"2026-10-10T10:00:00Z"}',
      ),
    ).toMatchObject({ type: 'notice', kind: 'joined', nick: 'Pedro' });
    expect(
      parseSocialMessage('{"type":"notice","kind":"left","nick":"Ana"}'),
    ).toMatchObject({ type: 'notice', kind: 'left' });
  });
});

describe('noticeText', () => {
  it('formula el aviso desde kind y nick', () => {
    const base = {
      event_id: 'n1',
      type: 'notice',
      room_id: 'r1',
      user_id: 'u1',
      text: 'ignorado',
      occurred_at: '2026-10-10T10:00:00Z',
    } as const;
    expect(noticeText({ ...base, nick: 'Pedro', kind: 'joined' })).toBe('Pedro entró al chat');
    expect(noticeText({ ...base, nick: 'Ana', kind: 'left' })).toBe('Ana salió del chat');
  });
});

describe('formatChatTime', () => {
  it('formatea HH:MM en hora local', () => {
    const out = formatChatTime('2026-10-10T10:05:00Z');
    expect(out).toMatch(/^\d{1,2}:\d{2}$/);
    const expected = new Date('2026-10-10T10:05:00Z').toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(out).toBe(expected);
  });

  it('retorna vacío si la fecha es inválida o vacía', () => {
    expect(formatChatTime('')).toBe('');
    expect(formatChatTime('no-fecha')).toBe('');
  });
});

describe('reaction', () => {
  it('set cerrado con los cinco emojis del documento', () => {
    expect([...REACTION_EMOJIS].sort()).toEqual(['❤️', '👏', '😂', '😮', '😱'].sort());
  });

  it('arma reaction_send con emoji y posición', () => {
    const parsed = JSON.parse(buildReactionSend('r1', '👏', 12000));
    expect(parsed).toMatchObject({
      type: 'reaction_send',
      room_id: 'r1',
      emoji: '👏',
      position_ms: 12000,
    });
    expect(typeof parsed.event_id).toBe('string');
    expect(typeof parsed.occurred_at).toBe('string');
  });

  it('posición por defecto 0', () => {
    expect(JSON.parse(buildReactionSend('r1', '❤️')).position_ms).toBe(0);
  });

  it('parsea el broadcast reaction', () => {
    expect(
      parseSocialMessage(
        '{"type":"reaction","event_id":"e1","room_id":"r1","user_id":"u1","nick":"Ana","emoji":"👏","position_ms":12000,"occurred_at":"t","received_at":"t"}',
      ),
    ).toMatchObject({ type: 'reaction', emoji: '👏', nick: 'Ana' });
  });
});
