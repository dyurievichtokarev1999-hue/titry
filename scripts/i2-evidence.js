// И2 (критик реализации; поручение владельца 18:05/18:59): свидетельство из CI на настоящем пути рендера.
// Вымышленный рассказ examples/day-quiet.json, заголовок заменён маркером. ffmpeg запускается через обёртку,
// которая записывает свою командную строку и передаёт вызов настоящему ffmpeg.
// Результат в каталоге <out>: argv.txt (командные строки ffmpeg), poster.jpg (кадр с заголовком),
// report.json (проверки). Код выхода ≠ 0, если маркер попал в командную строку или не получен кадр.
// Запуск: node scripts/i2-evidence.js out-i2
import fs from 'node:fs/promises';
import path from 'node:path';

export const MARKER = 'Маркер И2';
const out = path.resolve(process.argv[2] || 'out-i2');
await fs.mkdir(out, { recursive: true });
const argvFile = path.join(out, 'argv.txt');
const wrapper = path.join(out, 'ffmpeg-wrapper.sh');
const realFfmpeg = process.env.FFMPEG || 'ffmpeg';
await fs.writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "--- call" "$@" >> '${argvFile}'\nexec '${realFfmpeg}' "$@"\n`, { mode: 0o755 });
process.env.FFMPEG = wrapper;

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const ep = { ...ex.episode, title: MARKER };
const { renderEpisode, closeRenderer } = await import('../server/render.js');
const report = { sha: process.env.GITHUB_SHA || null, run: process.env.GITHUB_RUN_ID || null, story: 'examples/day-quiet.json (вымышленный)', marker: MARKER };
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
report.marker_in_argv = argv.includes(MARKER);
report.metadata_title_in_argv = /title=/.test(argv);
report.poster = await fs.stat(path.join(out, 'poster.jpg')).then((s) => s.size > 0).catch(() => false);
// Видео в артефакт не кладём: кадр с заголовком — poster.jpg.
await fs.rm(path.join(out, 'video.mp4'), { force: true });
await fs.rm(wrapper, { force: true });
if (report.ffmpeg_calls < 1 || report.marker_in_argv || report.metadata_title_in_argv || !report.poster) ok = false;
report.result = ok ? 'pass' : 'fail';
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ result: report.result, ffmpeg_calls: report.ffmpeg_calls, marker_in_argv: report.marker_in_argv, poster: report.poster }));
process.exit(ok ? 0 : 1);
