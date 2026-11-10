// Ежедневный ролик 24 с — проверка в CI (решение Claude, 10.11): до появления компьютера организатора
// единственный честный источник MP4. Не заменяет проверку на компьютере организатора и телефоне.
// Рассказ вымышленный (examples/), без реальных данных и ключей.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { renderEpisode, closeRenderer } from '../server/render.js';
import { DEFAULT_DURATION } from '../engine/draw.js';

let available = true;
try { createRequire(import.meta.url)('playwright'); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { available = false; }
// В CI пропуск запрещён: если браузера или ffmpeg нет, проверка должна упасть, а не пройти вхолостую.
const skip = !available && !process.env.CI && 'нет playwright, ffmpeg или ffprobe (локально)';

test('ежедневный ролик: 24 с, 720×1280, звук, постер (ffprobe)', { skip, timeout: 600000 }, async () => {
  assert.ok(available, 'в CI нужны playwright, ffmpeg и ffprobe');
  assert.equal(DEFAULT_DURATION, 24, 'длительность ежедневного ролика по умолчанию — 24 с');
  const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-daily-'));
  const out = path.join(dir, 'daily.mp4');
  const poster = path.join(dir, 'daily.jpg');
  try {
    // Как в боте (server/bot.js): пресет BOT_PRESET || 'standard', водяной знак по умолчанию,
    // длительность по умолчанию (не задаётся явно).
    await renderEpisode(ex.episode, {
      story: ex.story, outPath: out, posterPath: poster,
      preset: process.env.BOT_PRESET || 'standard',
      watermark: process.env.BOT_WATERMARK ?? 'сделано в титрах',
    });
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]).toString());
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    if (!process.env.BOT_PRESET) { assert.equal(v.width, 720); assert.equal(v.height, 1280); }
    assert.ok(a, 'есть звуковая дорожка');
    assert.ok(Math.abs(Number(a.duration) - 24) < 0.2, `звук на всю длину: ${a.duration}`);
    assert.ok(Math.abs(Number(probe.format.duration) - 24) < 0.2, `длительность ${probe.format.duration}`);
    assert.ok((await fs.stat(poster)).size > 5000, 'постер записан');
  } finally {
    await closeRenderer();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
