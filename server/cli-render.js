// Рендер эпизода из JSON-файла: node server/cli-render.js episode.json [out.mp4] [preview|standard|hd]
// Файл должен содержать { story, episode }: без исходного рассказа рендер не запускается.
import fs from 'node:fs/promises';
import { sanitizeEpisode, validateEpisode } from '../engine/episode.js';
import { renderEpisode, closeRenderer } from './render.js';

const [, , input, out, preset = 'standard'] = process.argv;
if (!input) {
  console.error('Использование: npm run render -- episode.json [out.mp4] [preview|standard|hd]');
  process.exit(2);
}
const raw = JSON.parse(await fs.readFile(input, 'utf8'));
const ep = sanitizeEpisode(raw.episode || raw);
const story = typeof raw.story === 'string' ? raw.story : '';
const v = validateEpisode(ep, story);
for (const w of v.warnings) console.warn('Предупреждение:', w.msg);
if (!v.ok) {
  for (const e of v.errors) console.error('Ошибка:', e.msg);
  process.exit(1);
}
try {
  const r = await renderEpisode(ep, { story, outPath: out, preset, posterPath: out ? out.replace(/\.mp4$/, '.jpg') : undefined });
  console.log(`Готово: ${r.outPath} (${r.frames} кадров, ${r.seconds.toFixed(1)} с)`);
} finally {
  await closeRenderer();
}
