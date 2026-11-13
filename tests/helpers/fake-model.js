// Поддельная модель для тестов (вариант 1, 12.11): заготовка без ИИ строк не предлагает, поэтому тестам, которым нужен
// черновик, строки «предлагает модель». Ответ проходит настоящий путь модели в makeDraft: groundDraft (дословность,
// «угроза не в титрах», местоимения), нехватка → заготовка → реплика нехватки. Строки — пары из фраз рассказа.
import { makeDraft, pairFromSentence } from '../../server/draft.js';

const storyOf = (content) => {
  const m = /<story>\n([\s\S]*)\n<\/story>/.exec(String(content));
  return m ? m[1] : '';
};

export function fakeModelClient({ title = 'Один день', genre = 'камерное кино', post = { text: '', source: '' } } = {}) {
  return { beta: { messages: { create: async ({ messages }) => {
    const story = storyOf(messages[0].content);
    const used = new Set();
    const rows = [];
    for (const s of story.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean)) {
      const p = pairFromSentence(s, used, story);
      if (p) { used.add(p.roleKey); rows.push(p.row); }
    }
    const raw = { title, genre, mood: 'quiet', grammatical_gender: 'unknown', safety_flag: false, rows: rows.slice(0, 6), post };
    return { stop_reason: 'end_turn', model: 'fake', usage: {}, content: [{ type: 'text', text: JSON.stringify(raw) }] };
  } } } };
}

/** Черновик «как от модели» для вымышленных рассказов тестов. */
export const modelLike = (story, o = {}) => makeDraft(story, { ...o, provider: 'claude', client: fakeModelClient() });
