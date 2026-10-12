import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const publicFile = (href: string) => resolve(root, 'public', href.replace(/^\//, ''));

function linkHref(rel: string): string {
  const match = html.match(new RegExp(`<link[^>]*rel="${rel}"[^>]*href="([^"]+)"`));
  expect(match, `<link rel="${rel}">`).not.toBeNull();
  return match![1];
}

describe('index.html', () => {
  it('declara un favicon existente (evita el 404 de /favicon.ico en cada carga)', () => {
    const href = linkHref('icon');
    expect(href).toMatch(/\.svg$/);
    expect(existsSync(publicFile(href))).toBe(true);
  });

  it('enlaza el apple-touch-icon y el manifest, y ambos existen', () => {
    expect(existsSync(publicFile(linkHref('apple-touch-icon')))).toBe(true);
    expect(existsSync(publicFile(linkHref('manifest')))).toBe(true);
  });

  it('declara theme-color', () => {
    expect(html).toMatch(/<meta[^>]*name="theme-color"[^>]*content="#[0-9A-Fa-f]{6}"/);
  });

  it('los iconos del manifest existen y cubren 192 y 512 px', () => {
    const manifest = JSON.parse(readFileSync(publicFile(linkHref('manifest')), 'utf8')) as {
      name: string;
      icons: { src: string; sizes: string }[];
    };
    expect(manifest.name).toMatch(/TINT/);
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of manifest.icons) expect(existsSync(publicFile(icon.src)), icon.src).toBe(true);
  });

  it('el logo completo existe para la UI', () => {
    expect(existsSync(publicFile('/logo.svg'))).toBe(true);
  });
});
