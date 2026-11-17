// Решение владельца 17:10 и редактор 18:25: временные строки исхода 2 с маркером «[срок не утверждён]»
// допустимы только на вымышленном стенде. Сборка для реальных данных (TITRY_RELEASE_REAL_DATA=1)
// не выпускается, пока маркер есть в коде. Обычный прогон проверяет, что маркер не показывается вне стенда.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const MARKER = '[срок не утверждён]';

// Все каталоги выпускаемого кода и текстов, рекурсивно.
const SHIPPED = ['server', 'engine', 'studio', 'config', 'concierge', 'brand'];

async function* files(dir) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) yield* files(p); else if (e.isFile()) yield p;
  }
}

test('выпуск для реальных данных: маркера «[срок не утверждён]» нет в выпускаемом коде', { skip: process.env.TITRY_RELEASE_REAL_DATA !== '1' && 'только при TITRY_RELEASE_REAL_DATA=1' }, async () => {
  for (const d of SHIPPED) {
    for await (const f of files(new URL(`../${d}/`, import.meta.url))) {
      const src = await fs.readFile(f, 'utf8').catch(() => '');
      assert.ok(!src.includes(MARKER), `маркер найден в ${f.pathname}: выпуск для реальных данных запрещён`);
    }
  }
});
