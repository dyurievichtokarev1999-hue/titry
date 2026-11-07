import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { splitOgg, transcribeOgg } from '../server/stt.js';

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }

test('длинное голосовое режется на куски не длиннее 30 секунд', { skip: !ffmpeg && 'нет ffmpeg' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-stt-'));
  try {
    const src = path.join(dir, 'voice.ogg');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=62', '-c:a', 'libopus', '-b:a', '24k', src]);
    const parts = await splitOgg(src, dir);
    assert.equal(parts.length, 3);
    for (const p of parts) {
      const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString());
      assert.ok(d <= 30, `кусок ${d} с`);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('без ключей распознавание честно сообщает, что выключено', async () => {
  const saved = process.env.YANDEX_API_KEY;
  delete process.env.YANDEX_API_KEY;
  await assert.rejects(transcribeOgg(Buffer.from('x')), (e) => e.code === 'stt_off');
  if (saved) process.env.YANDEX_API_KEY = saved;
});
