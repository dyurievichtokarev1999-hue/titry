// Экран остановки по безопасности (urgent / kind=safety): дословный текст, утверждённый владельцем,
// затем действующие контакты из config/help.json. Фразы о новом рассказе нет. Остальные исходы не меняются.
// Только вымышленные истории.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { helpMessage, loadHelp } from '../server/safety.js';
import { createBot, makeMetrics } from '../server/bot.js';
import { createApp } from '../server/app.js';

const APPROVED = 'Титры для этого рассказа не будут собраны. Если тебе или кому-то рядом прямо сейчас угрожает опасность, позвони по одному из номеров ниже или попроси человека рядом побыть с тобой.';
// Блок контактов — из действующей конфигурации, тем же форматом, что и экран помощи.
const CONTACTS = loadHelp().contacts.map((c) => `• ${c.label}: ${c.phone}${c.hours ? ` (${c.hours})` : ''}`).join('\n');
const EXPECTED = `${APPROVED}\n\n${CONTACTS}`;
const NEW_STORY = /нов\S* рассказ|Когда захочется|пришли|прислать|переформулир|ещё раз|снова/i;
const URGENT = 'Вечером сидел на подоконнике и думал, что не хочу больше жить.';
const CONCERN_OLD = `Похоже, в этом дне было что-то опасное или очень тяжёлое.\n\nЕсли тебе или кому-то рядом угрожает опасность, лучше обратиться за живой помощью:\n\n${CONTACTS}`;

test('экран остановки: дословный текст и контакты из конфигурации', () => {
  const text = helpMessage('urgent');
  assert.equal(text, EXPECTED);
  assert.doesNotMatch(text, NEW_STORY, 'нет приглашения прислать новый рассказ');
  assert.ok(CONTACTS.length > 0 && text.endsWith(`\n\n${CONTACTS}`), 'контакты идут сразу после текста');
  for (const c of loadHelp().contacts) assert.ok(text.includes(c.phone), `контакт ${c.label} на месте`);
});

test('экран остановки строит список контактов из переданной конфигурации', () => {
  const help = { region: 'XX', contacts: [{ label: 'Служба А', phone: '000', verified: true }, { label: 'Линия Б', phone: '0-000', hours: 'круглосуточно', verified: true }] };
  assert.equal(helpMessage('urgent', help), `${APPROVED}\n\n• Служба А: 000\n• Линия Б: 0-000 (круглосуточно)`);
});

test('предупреждение (concern) не изменилось', () => {
  assert.equal(helpMessage('concern'), CONCERN_OLD);
});

function fakeTelegram() {
  const sent = [];
  return { sent, send: async (chat, text) => { sent.push(text); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from('ogg'), sendVideo: async () => { sent.push('VIDEO'); } };
}

test('бот: остановка показывает дословный текст, без черновика, повтор — тот же экран', async () => {
  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-stop-'));
  try {
    let renders = 0;
    const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'test-salt-fictional-0001'), render: async () => { renders++; throw new Error('не должно вызываться'); }, draft: (s, o) => import('../server/draft.js').then((m) => m.makeDraft(s, { ...o, provider: 'manual' })) });
    const chat = { id: 11, type: 'private' };
    await bot.handleUpdate({ message: { chat, text: URGENT } });
    assert.ok(tg.sent.includes(EXPECTED), 'дословный текст в боте');
    assert.ok(!tg.sent.some((t) => NEW_STORY.test(t)), 'нет фразы о новом рассказе');
    assert.ok(!tg.sent.some((t) => /Похоже на твой день/.test(t)), 'черновика нет');
    const n = tg.sent.length;
    await bot.handleUpdate({ message: { chat, text: URGENT } });
    assert.ok(tg.sent.slice(n).includes(EXPECTED), 'повторная попытка — тот же экран остановки');
    assert.ok(!tg.sent.slice(n).some((t) => /Похоже на твой день/.test(t)), 'повторной выдачи нет');
    assert.equal(renders, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('монтажная: 422 safety несёт дословный текст; обычный рассказ — без экрана', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-stop-'));
  const server = createApp({
    dataDir,
    draft: (s, o) => import('../server/draft.js').then((m) => m.makeDraft(s, { ...o, provider: 'manual' })),
    safetyCheck: async () => false,
    hasKey: () => true,
    render: async () => { throw new Error('не должно вызываться'); },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const d = await post('/api/draft', { story: URGENT });
    assert.equal(d.status, 422);
    assert.equal(d.body.kind, 'safety');
    assert.equal(d.body.help, EXPECTED, 'дословный текст в монтажной');
    assert.ok(!d.body.episode, 'черновика нет');
    const again = await post('/api/draft', { story: URGENT });
    assert.equal(again.body.kind, 'safety'); assert.equal(again.body.help, EXPECTED, 'повтор не снимает остановку');
    const ok = await post('/api/draft', { story: 'Утром кофе, днём работа, вечером прогулка у реки.' });
    // Заготовка без модели строк не предлагает (PR 13, вариант 1): обычный рассказ — реплика нехватки, не остановка.
    assert.notEqual(ok.body.kind, 'safety'); assert.ok(!ok.body.help, 'обычный рассказ — без экрана помощи');
  } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
