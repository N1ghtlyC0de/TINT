import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

describe('index.html', () => {
  it('declara un favicon existente (evita el 404 de /favicon.ico en cada carga)', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8');
    const match = html.match(/<link[^>]*rel="icon"[^>]*href="([^"]+)"/);
    expect(match).not.toBeNull();
    const href = match![1];
    expect(existsSync(resolve(root, 'public', href.replace(/^\//, '')))).toBe(true);
  });
});
