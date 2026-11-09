// G0-fixes: неудачный запуск Chromium даёт понятную ошибку, не оставляет открытый сервер, и процесс завершается сам.
// Рассказ — вымышленный пример из examples/. Настоящий браузер не нужен: путь к нему заведомо неверный.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const renderUrl = new URL('../server/render.js', import.meta.url).href;
const exampleUrl = new URL('../examples/day-quiet.json', import.meta.url);

test('рендер: Chromium не запустился — ошибка code=browser, процесс завершается без force-exit', { timeout: 30000 }, async () => {
  const script = `
    import fs from 'node:fs/promises';
    const { renderEpisode } = await import(${JSON.stringify(renderUrl)});
    const ex = JSON.parse(await fs.readFile(new URL(${JSON.stringify(exampleUrl.href)}), 'utf8'));
    for (let i = 0; i < 2; i++) {
      try { await renderEpisode(ex.episode, { story: ex.story, outPath: process.env.OUT, preset: 'preview', duration: 16 }); console.log('unexpected-ok'); }
      catch (e) { console.log('code=' + e.code + ' mentions=' + /TITRY_CHROMIUM/.test(e.message)); }
    }`;
  const os = await import('node:os');
  const path = await import('node:path');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TITRY_CHROMIUM: '/nonexistent/titry-chromium', OUT: path.join(os.tmpdir(), `titry-launch-${process.pid}.mp4`) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 20000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.notEqual(code, 'hung', 'процесс не завершился сам: остался открытый сервер или браузер');
  // Обе попытки дают понятную ошибку: неудачный запуск не закэширован как «вечный» отказ без пояснения.
  assert.deepEqual(out.trim().split('\n'), ['code=browser mentions=true', 'code=browser mentions=true']);
});
