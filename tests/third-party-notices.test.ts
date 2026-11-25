/**
 * The third-party notices shipped with the site (public/THIRD_PARTY_NOTICES.txt, copied to dist/) and kept in
 * the repository (THIRD_PARTY_NOTICES.md) reproduce the copyright lines and licence texts of every component
 * of the redistributed Pyodide files listed in licenses/pyodide-components.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Component { name: string; version: string; licence: string; files: string[]; source: string; copyright: string[]; texts: string[] }
interface Manifest { pyodide: string; files: string[]; components: Component[]; texts: Record<string, string> }

const root = join(import.meta.dirname, '..');
const read = (...path: string[]): string => readFileSync(join(root, ...path), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(read('licenses', 'pyodide-components.json')) as Manifest;
const notices = read('public', 'THIRD_PARTY_NOTICES.txt');
const licenceText = (file: string): string => read('licenses', file).replace(/^\s*\n/, '').trimEnd();

describe('third-party notices', () => {
  it('keeps the repository copy identical to the copy shipped with the site', () => {
    expect(read('THIRD_PARTY_NOTICES.md')).toBe('# Third-party notices\n\n```text\n' + notices + '```\n');
  });

  it('names the installed Pyodide version and the files that the build copies', () => {
    expect(manifest.pyodide).toBe((JSON.parse(read('node_modules', 'pyodide', 'package.json')) as { version: string }).version);
    const copied = /const files = \[([^\]]*)\]/.exec(read('scripts', 'copy-runtime.mjs'))?.[1].match(/'[^']+'/g)?.map((s) => s.slice(1, -1));
    expect(manifest.files).toEqual(copied);
    expect(notices).toContain(`Pyodide ${manifest.pyodide}`);
    for (const file of manifest.files) expect(notices).toContain(file);
  });

  it('reproduces the copyright lines and licence texts of every component of the Pyodide files', () => {
    expect(manifest.components.length).toBeGreaterThan(0);
    for (const c of manifest.components) {
      expect(notices, c.name).toContain(c.name);
      for (const line of c.copyright) expect(notices, c.name).toContain(line);
      for (const file of c.texts) {
        expect(manifest.texts[file], `${c.name}: source of ${file}`).toBeTruthy();
        expect(notices, `${c.name}: ${file}`).toContain(licenceText(file));
      }
    }
  });

  it('covers the libraries linked into pyodide.asm.wasm', () => {
    const lower = notices.toLowerCase();
    for (const term of ['krah', 'mpdec', 'expat', 'mimalloc', 'zstd', 'hacl', 'libffi', 'matsumoto']) expect(lower, term).toContain(term);
  });
});
