import { describe, expect, it } from 'vitest';
import {
  buildLaserPoint,
  buildPollClose,
  buildPollCreate,
  buildPollVote,
  buildRecapRequest,
  formatMmSs,
  clamp01,
  parseSocialMessage,
  pollPercentages,
  POLL_DURATIONS_S,
  validatePollDraft,
} from './socialSocket';

describe('canal social — puntero láser', () => {
  it('parsea el broadcast laser', () => {
    const msg = { type: 'laser', event_id: 'e1', user_id: 'u1', nick: 'Host', x: 0.5, y: 0.25, end: false };
    expect(parseSocialMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it('buildLaserPoint arma laser_point con coordenadas normalizadas', () => {
    const frame = JSON.parse(buildLaserPoint('r1', 0.123456, 1.4, false, 'ev-1'));
    expect(frame).toEqual({ type: 'laser_point', event_id: 'ev-1', room_id: 'r1', x: 0.1235, y: 1 });
  });

  it('el último punto del trazo lleva end: true', () => {
    const frame = JSON.parse(buildLaserPoint('r1', -2, 0.5, true));
    expect(frame).toMatchObject({ type: 'laser_point', x: 0, y: 0.5, end: true });
    expect(typeof frame.event_id).toBe('string');
  });

  it.each([
    [Number.NaN, 0],
    [-1, 0],
    [0.5, 0.5],
    [2, 1],
  ])('clamp01(%f) → %f', (v, out) => {
    expect(clamp01(v)).toBe(out);
  });
});

describe('canal social — encuestas', () => {
  it('parsea poll_state y error', () => {
    const state = { type: 'poll_state', poll_id: 'p1', question: '¿Quién fue?', options: ['A', 'B'], counts: [1, 2], closes_at_ms: 5, closed: false };
    expect(parseSocialMessage(JSON.stringify(state))).toEqual(state);
    expect(parseSocialMessage(JSON.stringify({ type: 'error', code: 'POLL_ACTIVE', event_id_ref: 'e' }))).toMatchObject({ code: 'POLL_ACTIVE' });
  });

  it('arma poll_create, poll_vote y poll_close', () => {
    expect(JSON.parse(buildPollCreate('r1', ' ¿Final? ', [' Sí ', 'No'], 60, 'e1'))).toEqual({
      type: 'poll_create',
      event_id: 'e1',
      room_id: 'r1',
      question: '¿Final?',
      options: ['Sí', 'No'],
      duration_s: 60,
    });
    expect(JSON.parse(buildPollVote('r1', 'p1', 1, 'e2'))).toEqual({ type: 'poll_vote', event_id: 'e2', room_id: 'r1', poll_id: 'p1', option: 1 });
    expect(JSON.parse(buildPollClose('r1', 'p1', 'e3'))).toEqual({ type: 'poll_close', event_id: 'e3', room_id: 'r1', poll_id: 'p1' });
    expect(typeof JSON.parse(buildPollVote('r1', 'p1', 0)).event_id).toBe('string');
    expect(typeof JSON.parse(buildPollClose('r1', 'p1')).event_id).toBe('string');
    expect(typeof JSON.parse(buildPollCreate('r1', 'q', ['a', 'b'], 30)).event_id).toBe('string');
  });

  it.each([
    ['', ['a', 'b'], 60, 'Escribe la pregunta.'],
    ['x'.repeat(141), ['a', 'b'], 60, 'La pregunta admite hasta 140 caracteres.'],
    ['¿?', ['a'], 60, 'Añade entre 2 y 4 opciones.'],
    ['¿?', ['a', 'b', 'c', 'd', 'e'], 60, 'Añade entre 2 y 4 opciones.'],
    ['¿?', ['a', ' '], 60, 'Completa todas las opciones.'],
    ['¿?', ['a', 'y'.repeat(61)], 60, 'Cada opción admite hasta 60 caracteres.'],
    ['¿?', ['a', 'A '], 60, 'Las opciones deben ser distintas.'],
    ['¿?', ['a', 'b'], 7, 'Elige una duración válida.'],
    ['¿?', ['a', 'b'], 60, null],
  ])('validatePollDraft(%s, %j, %i) → %s', (q, opts, d, out) => {
    expect(validatePollDraft(q, opts, d)).toBe(out);
  });

  it('duraciones ofrecidas', () => {
    expect(POLL_DURATIONS_S).toEqual([30, 60, 120, 300]);
  });

  it.each([
    [[0, 0], [0, 0]],
    [[1, 1], [50, 50]],
    [[1, 2], [33, 67]],
    [[3, 0, 1], [75, 0, 25]],
  ])('pollPercentages(%j) → %j', (counts, out) => {
    expect(pollPercentages(counts)).toEqual(out);
  });
});

describe('canal social — recap', () => {
  it('parsea recap y arma recap_request', () => {
    const recap = {
      type: 'recap',
      room_id: 'r1',
      event_id_ref: 'e1',
      top_emoji_user: null,
      most_paused: null,
      peak_reactions: null,
      totals: { reactions: 0, pauses: 0, rewinds: 0, polls: 0 },
    };
    expect(parseSocialMessage(JSON.stringify(recap))).toEqual(recap);
    expect(JSON.parse(buildRecapRequest('r1', 'e9'))).toEqual({ type: 'recap_request', event_id: 'e9', room_id: 'r1' });
    expect(typeof JSON.parse(buildRecapRequest('r1')).event_id).toBe('string');
  });

  it.each([
    [0, '00:00'],
    [-10, '00:00'],
    [65_400, '01:05'],
    [3_725_000, '62:05'],
  ])('formatMmSs(%i) → %s', (ms, out) => {
    expect(formatMmSs(ms)).toBe(out);
  });
});
