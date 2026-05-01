// Topic taxonomy. Fixed canonical 8 categories — keeps tag space clean.
// Per-topic prompt banks live in prompts.ts (TOPIC_PROMPTS).

export interface TopicDef {
  key: string;     // canonical, ASCII, used as D1 PK + #tag
  emoji: string;
  zh: string;
  en: string;
}

export const TOPICS: TopicDef[] = [
  { key: 'work',   emoji: '💼',  zh: '工作',     en: 'Work' },
  { key: 'friend', emoji: '👫',  zh: '朋友',     en: 'Friends' },
  { key: 'family', emoji: '👨‍👩‍👧', zh: '家',       en: 'Family' },
  { key: 'love',   emoji: '💕',  zh: '感情',     en: 'Love' },
  { key: 'self',   emoji: '🧠',  zh: '自我',     en: 'Self' },
  { key: 'goal',   emoji: '🎯',  zh: '目标',     en: 'Goals' },
  { key: 'health', emoji: '🌱',  zh: '健康',     en: 'Health' },
  { key: 'random', emoji: '💭',  zh: '随便聊',   en: 'Random' },
];

export const TOPIC_KEYS = TOPICS.map((t) => t.key);
export const TOPIC_BY_KEY: Record<string, TopicDef> = Object.fromEntries(TOPICS.map((t) => [t.key, t]));

/** Inline keyboard for topic picker. 2-col grid. */
export function topicKeyboard(): any {
  const rows: any[][] = [];
  for (let i = 0; i < TOPICS.length; i += 2) {
    const row = TOPICS.slice(i, i + 2).map((t) => ({
      text: `${t.emoji} ${t.zh} / ${t.en}`,
      callback_data: `topic:${t.key}`,
    }));
    rows.push(row);
  }
  return { inline_keyboard: rows };
}
