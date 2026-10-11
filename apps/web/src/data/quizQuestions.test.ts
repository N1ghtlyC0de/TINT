/// <reference types="node" />
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { QUIZ_CATEGORIES, quizQuestions } from './quizQuestions';

const REPO_ROOT = resolve(__dirname, '../../../..');

describe('banco de preguntas del cuestionario', () => {
  it('tiene exactamente 60 preguntas con ids únicos', () => {
    expect(quizQuestions).toHaveLength(60);
    expect(new Set(quizQuestions.map((q) => q.id)).size).toBe(60);
  });

  it('cada pregunta tiene 4 opciones distintas y una respuesta válida', () => {
    for (const q of quizQuestions) {
      expect(q.options, q.id).toHaveLength(4);
      expect(new Set(q.options).size, q.id).toBe(4);
      expect(q.answer, q.id).toBeGreaterThanOrEqual(0);
      expect(q.answer, q.id).toBeLessThan(4);
      expect(q.prompt.trim(), q.id).not.toBe('');
      expect(q.explanation.trim(), q.id).not.toBe('');
    }
  });

  it('cada fuente citada existe en el repositorio', () => {
    for (const q of quizQuestions) {
      expect(q.sources.length, q.id).toBeGreaterThan(0);
      for (const src of q.sources) {
        const file = src.split('#')[0];
        expect(existsSync(resolve(REPO_ROOT, file)), `${q.id}: ${file}`).toBe(true);
      }
    }
  });

  it('reparte las preguntas según el conteo por categoría', () => {
    const counts = Object.fromEntries(QUIZ_CATEGORIES.map((c) => [c.id, 0]));
    for (const q of quizQuestions) counts[q.category] += 1;
    for (const c of QUIZ_CATEGORIES) expect(counts[c.id], c.id).toBe(c.expected);
  });

  it('no concentra la respuesta correcta en una sola posición', () => {
    const positions = [0, 0, 0, 0];
    for (const q of quizQuestions) positions[q.answer] += 1;
    for (const n of positions) expect(n).toBeGreaterThanOrEqual(8);
  });
});
