// Сравнение вариантов движения по одной переменной (разбор моушн-дизайнера GPT, 7.11.2026).
// Запуск: node scripts/render-variants.js [папка-вывода]
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderEpisode, closeRenderer, ROOT } from '../server/render.js';
import { timeline } from '../engine/draw.js';

const out = path.resolve(process.argv[2] || path.join(ROOT, 'data', 'variants'));
await fs.mkdir(out, { recursive: true });
const VARIANTS = [
  { id: 'A-base', label: 'исходный (с исправленной прозрачностью)', opts: {} },
  { id: 'B-typo', label: 'только типографика v2', opts: { typo: 'v2' } },
  { id: 'C-speed', label: 'только ровная скорость', opts: { ease: 'linear' } },
  { id: 'D-timing', label: 'только тайминг v2', opts: { timing: 'v2' } },
  { id: 'E-all', label: 'все три вместе', opts: { typo: 'v2', ease: 'linear', timing: 'v2' } },
];
try {
  for (const name of ['stress-3-pairs', 'stress-6-pairs']) {
    const ex = JSON.parse(await fs.readFile(path.join(ROOT, 'examples', `${name}.json`), 'utf8'));
    for (const v of VARIANTS) {
      const file = path.join(out, `${name}--${v.id}.mp4`);
      const r = await renderEpisode(ex.episode, { story: ex.story, outPath: file, preset: 'standard', ...v.opts });
      console.log(`${path.basename(file)}  ${v.label}  ${r.seconds.toFixed(1)} с`);
    }
  }
} finally { await closeRenderer(); }

const row = (T) => {
  const f = (x) => x.toFixed(1);
  return `| ${T.variant} | 0–${f(T.titleHold)} | ${f(T.titleHold)}–${f(T.rollEnd)} | ${f(T.rollEnd)}–${f(T.blackStart)} | ${f(T.blackStart)}–${f(T.blackStart + T.sceneFade)} | ${f(T.blackStart + T.sceneFade)}–${f(T.postStart)} | ${f(T.postStart)}–${f(T.postStart + T.postFadeIn)} | ${f(T.postStart + T.postFadeIn)}–${f(T.duration - T.fadeOut)} | ${f(T.duration - T.fadeOut)}–${f(T.duration)} |`;
};
const table = ['| Тайминг | Название | Прокрутка | «Конец сцены» стоит | Уход титров | Пустая темнота | Появление фразы | Фраза полностью видна | Уход |', '|---|---|---|---|---|---|---|---|---|', row(timeline(24, 'v1')), row(timeline(24, 'v2'))].join('\n');
await fs.writeFile(path.join(out, 'timeline.md'), `# Границы таймлайна, 24 с\n\n${table}\n`);
console.log(table);
