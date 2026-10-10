import { describe, expect, it } from 'vitest';
import {
  buildChatSend,
  buildSocialUrl,
  CHAT_MAX_LENGTH,
  parseSocialMessage,
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
});
