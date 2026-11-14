#!/usr/bin/env node
// Builds a single self-contained HTML: Three.js + CSS + game, no network requests.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

// --- inline three.module.js as a global namespace, wrapped in an IIFE ---
let three = read('vendor/three.module.js');
const exp = three.match(/export \{([\s\S]*?)\};?\s*$/);
if (!exp) throw new Error('three.module.js: export block not found');
const names = exp[1].split(',').map((s) => s.trim()).filter(Boolean);
const mappings = names.map((n) => {
  const m = n.match(/^(\S+)\s+as\s+(\S+)$/);
  return m ? `${m[2]}:${m[1]}` : n;
});
const body = three.slice(0, exp.index);
three = `/* Three.js r169 (MIT) — inlined for a fully offline, self-contained page. */\nwindow.THREE=(function(){\n${body}\nreturn {${mappings.join(',')}};\n})();`;

let template = read('src/index.template.html');
const style = read('src/style.css');
const game = readdirSync(join(HERE, 'src/js')).filter((f) => f.endsWith('.js')).sort()
  .map((f) => `\n/* ================= ${f} ================= */\n` + read('src/js/' + f)).join('\n');
for (const [tag, value] of [['/*__STYLE__*/', style], ['/*__THREE__*/', three], ['/*__GAME__*/', game]]) {
  if (!template.includes(tag)) throw new Error('template tag missing: ' + tag);
  template = template.split(tag).join(value);
}
// Guard: the shipped page must make zero network requests.
if (/\b(fetch\(|XMLHttpRequest|import\s*\(|@import\s+url|https?:\/\/[^\s"']+\.(js|css|png|jpg|woff2?))/i.test(game + style)) {
  console.warn('WARNING: possible network reference in source');
}
mkdirSync(join(HERE, 'dist'), { recursive: true });
const out = join(HERE, 'dist', 'sunset-district.html');
writeFileSync(out, template);
console.log(`built ${out}  ${(template.length / 1024).toFixed(0)} KB`);
