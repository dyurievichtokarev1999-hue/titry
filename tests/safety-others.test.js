// Аудит 17.11, п. 1 (решения 12.11 и 7.11): модельная проверка видит угрозу другим людям; бытовые гиперболы — ролик.
// Подставная модель, настоящий createApp; фразы вымышленные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { SAFETY_PROMPT, modelSafetyCheck } from '../server/draft.js';
import { assessRisk } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const OTHERS = [
  'Я его так отделал, что он теперь в больнице.',
  'Купил топор. Завтра сосед ответит за всё.',
  'Сосед своё получит, я уже канистру бензина купил.',
  'Держала сестру взаперти.',
];
const HYPERBOLE = [
  'Убил бы за это опоздание.',
  'Брат меня сегодня просто убил своей шуткой.',
  'Готова была разорвать этот принтер.',
  'Порвал всех на турнире по шахматам.',
  'Убила бы за чашку кофе с утра.',
];

// Подставная модель: отвечает заданным флагом и запоминает, с каким промптом её спросили.
function fakeModel(flag) {
  const seen = [];
  const client = { beta: { messages: { create: async (req) => { seen.push(req.system); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ safety_flag: flag }) }] }; } } } };
  return { seen, check: (s) => modelSafetyCheck(s, { client }) };
}

async function renderWith(story, check) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-oth-'));
  const server = createApp({ dataDir, safetyCheck: check, hasKey: () => true, checkRetryMs: 0, render: async (e, o) => ({ seconds: 1, outPath: o.outPath }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story, episode: structuredClone(ex.episode) }) });
    return { status: res.status, body: await res.json() };
  } finally { server.closeAllConnections(); server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

test('промпт модельной проверки: угроза и вред другому человеку, в том числе уже совершённые; гиперболы — нет', () => {
  assert.match(SAFETY_PROMPT, /опасность грозит другому человеку/);
  assert.match(SAFETY_PROMPT, /собираются причинить вред/);
  assert.match(SAFETY_PROMPT, /держат взаперти/);
  assert.match(SAFETY_PROMPT, /уже сделанного/);
  assert.match(SAFETY_PROMPT, /сам рассказчик/);
  assert.match(SAFETY_PROMPT, /«убил бы за это опоздание»/);
});

// Локальный фильтр на 17.11 оценивает эти фразы как none; это не закрепляется тестом, чтобы не мешать будущему правилу.
test('четыре фразы аудита: флаг модели даёт остановку — 422 safety с 112', async () => {
  for (const phrase of OTHERS) {
    const story = `${ex.story} ${phrase}`;
    const m = fakeModel(true);
    const r = await renderWith(story, m.check);
    assert.equal(r.status, 422, phrase);
    assert.equal(r.body.kind, 'safety', phrase);
    assert.match(r.body.help, /112/, phrase);
    assert.equal(m.seen[0], SAFETY_PROMPT, 'модель спрошена с этим промптом');
  }
});

test('бытовые гиперболы (решение 7.11): модель не ставит флаг — ролик собирается', async () => {
  for (const phrase of HYPERBOLE) {
    const story = `${ex.story} ${phrase}`;
    assert.equal(assessRisk(story).level, 'none', `локально none: ${phrase}`);
    const r = await renderWith(story, fakeModel(false).check);
    assert.equal(r.status, 200, phrase);
    assert.notEqual(r.body.kind, 'safety', phrase);
  }
});
