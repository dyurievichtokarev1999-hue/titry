// Дымовой тест рендера: настоящий Chromium и ffmpeg. Пропускается, если их нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { renderEpisode, closeRenderer } from '../server/render.js';

let available = true;
try { createRequire(import.meta.url)('playwright'); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { available = false; }

test('рендер: MP4 9:16 со звуком нужной длительности', { skip: !available && 'нет playwright или ffmpeg' }, async () => {
  const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-render-'));
  const out = path.join(dir, 'x.mp4');
  try {
    const r = await renderEpisode(ex.episode, { outPath: out, preset: 'preview', duration: 16, posterPath: path.join(dir, 'x.jpg') });
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]).toString());
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    assert.equal(v.width, 540);
    assert.equal(v.height, 960);
    assert.ok(a, 'есть звуковая дорожка');
    assert.ok(Math.abs(Number(probe.format.duration) - 16) < 0.2);
    assert.ok((await fs.stat(r.posterPath)).size > 5000);
  } finally {
    await closeRenderer();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('рендер отказывается от эпизода с ошибками', async () => {
  await assert.rejects(renderEpisode({ title: '', rows: [] }), /не готов к рендеру/);
});
