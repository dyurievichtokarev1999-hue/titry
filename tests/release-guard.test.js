// Решение владельца 17:10 и редактор 18:25: временные строки исхода 2 с маркером «[срок не утверждён]»
// допустимы только на вымышленном стенде. Сборка для реальных данных (TITRY_RELEASE_REAL_DATA=1)
// не выпускается, пока маркер есть в коде. Обычный прогон проверяет, что маркер не показывается вне стенда.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const MARKER = '[срок не утверждён]';

test('выпуск для реальных данных: маркера «[срок не утверждён]» нет в server/', { skip: process.env.TITRY_RELEASE_REAL_DATA !== '1' && 'только при TITRY_RELEASE_REAL_DATA=1' }, async () => {
  const dir = new URL('../server/', import.meta.url);
  for (const f of await fs.readdir(dir)) {
    const src = await fs.readFile(new URL(f, dir), 'utf8');
    assert.ok(!src.includes(MARKER), `маркер найден в server/${f}: выпуск для реальных данных запрещён`);
  }
});
