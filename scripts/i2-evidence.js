// И2 (критик реализации; поручение владельца 18:05/18:59): свидетельство из CI на настоящем пути рендера.
// Вымышленный рассказ examples/day-quiet.json, заголовок заменён маркером. ffmpeg запускается через обёртку,
// которая записывает свою командную строку и передаёт вызов настоящему ffmpeg.
// Результат в каталоге <out>: argv.txt (командные строки ffmpeg), poster.jpg (кадр с заголовком),
// report.json (проверки). Код выхода ≠ 0, если маркер попал в командную строку или не получен кадр.
// Запуск: node scripts/i2-evidence.js out-i2
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MARKER = 'Маркер И2';
const out = path.resolve(process.argv[2] || 'out-i2');
await fs.mkdir(out, { recursive: true });
const argvFile = path.join(out, 'argv.txt');
const wrapper = path.join(out, 'ffmpeg-wrapper.sh');
const realFfmpeg = process.env.FFMPEG || 'ffmpeg';
const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`; // безопасные кавычки для sh
await fs.writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "--- call" "$@" >> ${sq(argvFile)}\nexec ${sq(realFfmpeg)} "$@"\n`, { mode: 0o755 });
process.env.FFMPEG = wrapper;

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const ep = { ...ex.episode, title: MARKER };
const { renderEpisode, closeRenderer } = await import('../server/render.js');
const report = { sha: process.env.HEAD_SHA || process.env.GITHUB_SHA || null, merge_sha: process.env.GITHUB_SHA || null, run: process.env.GITHUB_RUN_ID || null, story: 'examples/day-quiet.json (вымышленный)', marker: MARKER };
let ok = true;
try {
  const r = await renderEpisode(ep, { story: ex.story, outPath: path.join(out, 'video.mp4'), posterPath: path.join(out, 'poster.jpg'), preset: 'preview', duration: 16 });
  report.render = 'ok';
  report.seconds = Math.round(r.seconds);
} catch (e) {
  report.render = `fail:${e.code || 'error'}`;
  ok = false;
} finally { await closeRenderer(); }

const argv = await fs.readFile(argvFile, 'utf8').catch(() => '');
report.ffmpeg_calls = (argv.match(/^--- call$/gm) || []).length;
// Не только точная строка: экранированный, слитный и URL-кодированный виды, любая часть маркера.
const lower = argv.toLowerCase();
report.marker_in_argv = ['маркер', 'и2', encodeURIComponent('Маркер').toLowerCase()].some((m) => lower.includes(m));
report.metadata_title_in_argv = /title=/.test(argv);
report.poster = await fs.stat(path.join(out, 'poster.jpg')).then((s) => s.size > 0).catch(() => false);
// Кадр из самого MP4 (настоящим ffmpeg, мимо обёртки) в момент, когда стоит название: доказывает, что
// заголовок есть в собранном ролике, а не только на странице. Видео в артефакт не кладём.
const titleAt = 3.2 - 0.5; // engine/draw.js: titleHold 3.2 с
const fr = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(titleAt), '-i', path.join(out, 'video.mp4'), '-frames:v', '1', path.join(out, 'frame-from-mp4.jpg')]);
report.frame_from_mp4 = fr.status === 0 && await fs.stat(path.join(out, 'frame-from-mp4.jpg')).then((st) => st.size > 0).catch(() => false);
await fs.rm(path.join(out, 'video.mp4'), { force: true });
await fs.rm(wrapper, { force: true });
if (report.ffmpeg_calls < 1 || report.marker_in_argv || report.metadata_title_in_argv || !report.poster || !report.frame_from_mp4) ok = false;
report.result = ok ? 'pass' : 'fail';
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ result: report.result, ffmpeg_calls: report.ffmpeg_calls, marker_in_argv: report.marker_in_argv, poster: report.poster, frame_from_mp4: report.frame_from_mp4 }));
process.exit(ok ? 0 : 1);
