// Хелпер «пройти подтверждения» (экраны 6А → 6Б/6Г → 6Ж, server/consent.js) для тестов, которые шлют рассказ сразу.
// createBot — настоящий createBot из server/bot.js; перед первым сообщением чата и после каждого «/start» (он начинает
// с 6А) и «/delete» (стирает сессию с отметкой) хелпер нажимает настоящие кнопки подтверждений. Сообщения и метрики
// этих шагов скрыты от подмен теста, поэтому логика их проверок не меняется. Проверки самих экранов —
// tests/consent-screens.test.js, там этот хелпер не используется.
import { createBot as realCreateBot } from '../../server/bot.js';
import { consentSteps } from '../../server/consent.js';

const HELPER_QUERY = 'consent-helper';

/** Пройти подтверждения через handle (handleUpdate бота): начать диалог, нажать «Дальше» и согласия по порядку. */
export async function passConsent(handle, chat, { order = consentSteps(), begin = true } = {}) {
  if (begin) await handle({ message: { chat, text: 'настройки' } }); // до подтверждений — 6З и 6А, рассказ не принимается
  for (const data of ['cs:intro:next', ...order.map((step) => `cs:${step}:yes`)]) {
    await handle({ callback_query: { id: HELPER_QUERY, data, message: { chat } } });
  }
}

export function createBot(opts = {}) {
  const muted = new Set();
  // Глушатся только ответы шагов подтверждения (send, answer) и метрика log; остальное (sendVideo, hash…) — как есть.
  const quiet = (obj, names) => obj && new Proxy(obj, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function' || !names.includes(k)) return v;
      return (...a) => (muted.has(a[0]) || a[0] === HELPER_QUERY ? Promise.resolve() : v.apply(t, a));
    },
  });
  const bot = realCreateBot({ ...opts, tg: quiet(opts.tg, ['send', 'answer']), ...(opts.metrics ? { metrics: quiet(opts.metrics, ['log']) } : {}) });
  const handle = bot.handleUpdate;
  const ready = new Map();
  const silently = async (chat, fn) => { muted.add(chat.id); try { await fn(); } finally { muted.delete(chat.id); } };
  bot.handleUpdate = async (u) => {
    const chat = (u.message || u.edited_message || u.callback_query?.message)?.chat;
    const own = chat && chat.type === 'private';
    if (own) {
      if (!ready.has(chat.id)) ready.set(chat.id, silently(chat, () => passConsent(handle, chat, { order: opts.consentOrder })));
      await ready.get(chat.id);
    }
    const r = await handle(u);
    const text = u.message?.text;
    if (own && text === '/start') await silently(chat, () => passConsent(handle, chat, { order: opts.consentOrder, begin: false }));
    if (own && text === '/delete') ready.delete(chat.id);
    return r;
  };
  return bot;
}
