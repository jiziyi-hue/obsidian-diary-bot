// Topic-keyed journaling prompt banks. Picked randomly when user selects a
// topic; user can re-roll for variety or skip to free chat.

export const TOPIC_PROMPTS: Record<string, string[]> = {
  work: [
    '今天工作上发生了什么? 顺利的, 卡住的, 或意外的, 都行。',
    '你今天最有干劲的瞬间是什么时候?',
    '今天有没有哪个决定让你犹豫了很久?',
    '今天工作里, 哪件事让你觉得"还行"或者"挺好"?',
    '现在让你停下手里的事, 你最想完成的是哪一项?',
    '本周到目前为止, 哪件事消耗了你最多精力?',
    '今天有没有谁的反馈让你想多想想?',
    '你这周做的事情, 跟上周比有什么不一样?',
    '如果今天能重来一次, 你会怎么用这一天?',
    '现在 work 上, 你最不想面对的是什么?',
    'How was work today — smooth, stuck, or surprising?',
    'What part of today actually energized you?',
    'What\'s the thing you keep avoiding?',
  ],
  friend: [
    '今天有跟谁见面或聊天吗? 印象最深的一刻是?',
    '最近有谁让你笑出声? 因为什么事?',
    '你最近想念哪个朋友, 但还没联系?',
    '今天有谁说的话还在你脑子里转?',
    '你跟朋友最近一次见面, 有什么想再聊但没聊到的?',
    '哪个朋友让你觉得"在我身上看见了真实的我"?',
    'Who made you smile today, and how?',
    'Anyone you\'ve been thinking about but haven\'t reached out to?',
    'What conversation today is still echoing?',
  ],
  family: [
    '今天家里有什么互动? 有没有让你心里一动的小事?',
    '最近最让你挂念的家人是谁? 因为什么?',
    '你今天对家人有没有什么话想说但没说?',
    '家里最近有什么变化, 你怎么看?',
    '哪个家人最近让你觉得熟悉里有了点新东西?',
    '你的家庭让你最舒服的, 是什么时候?',
    'How was family today, even if you didn\'t see them?',
    'What\'s one family pattern you\'re becoming more aware of?',
  ],
  love: [
    '感情里今天有什么感觉? 平静, 期待, 困惑, 任意一个。',
    '最近你想到 ta 时, 第一个念头是什么?',
    '你跟 ta 之间, 有没有什么事是你不太敢提起的?',
    '你希望 ta 怎么了解你? 但你还没让对方看见?',
    '最近一次让你心动 / 心暖 / 心累的瞬间是什么?',
    '你在感情里, 给自己什么是不太够的?',
    'Anything in your love life today — even just a flicker?',
    'What is unspoken between you and someone close?',
    'When did you last feel truly seen?',
  ],
  self: [
    '今天的你跟昨天的你有什么不同?',
    '今天你身体最强的感觉是什么? (累 / 紧 / 松 / 暖)',
    '今天有哪个瞬间, 你感觉"是真正的自己"?',
    '你今天对自己说了什么话? 是对自己的好话还是责备?',
    '你最近反复在想的一个问题是什么?',
    '哪个习惯你想改但还没改?',
    '你今天最想逃避的是什么? 它背后是什么?',
    '哪种情绪你最近比较常出现, 但还没仔细看过?',
    '现在让你形容你自己, 用三个词, 你会用哪三个?',
    '今天你最骄傲的是哪件事, 哪怕很小?',
    '今天什么事消耗了你最多, 跟昨天一样吗?',
    '你最近对自己最大的发现是什么?',
    'What\'s one thought that\'s been circling lately?',
    'When did you feel most yourself today?',
    'What feeling are you avoiding naming?',
    'What did your body experience today?',
    'What story did you tell yourself today — is it true?',
  ],
  goal: [
    '你最近在追的目标怎么样了?',
    '哪个目标你已经"想"了很久, 但还没真正开始?',
    '本周如果只能完成一件事, 你会选哪件?',
    '什么资源 / 时间 / 人脉 / 技能 出现你就能往前一大步?',
    '你过去阻碍自己的, 现在还在吗?',
    '你已经"差不多到目标"的, 是哪件?',
    '哪个目标其实你已经不想做了, 但没承认?',
    '5 年后回看现在, 你最不想后悔的是什么?',
    'What\'s one tiny step you can take this week toward something that matters?',
    'What goal have you been thinking about but not writing down?',
    'What are you tolerating that you could change?',
  ],
  health: [
    '身体今天怎么样? 睡眠, 饮食, 运动, 任意一个。',
    '今天身体在哪里特别紧 / 累 / 不舒服?',
    '你最近一次觉得身体真正放松, 是什么时候?',
    '哪件事你身体在抗议, 你脑子还在让它继续?',
    '你今天吃的最满足的一餐是什么?',
    '最近睡眠怎么样? 入睡难还是醒来累?',
    '你最近有没有哪种小习惯做了之后觉得身体好一点?',
    '心理状态今天怎么打分? 1-10。原因是?',
    '今天你给自己的小关照是什么?',
    'How are body and mind today?',
    'What does your body need this morning — water, stretch, stillness?',
    'When did you last feel rested?',
  ],
  random: [
    '想说啥说啥。',
    '今天有什么让你印象深的小事?',
    '现在脑子里飘的是什么?',
    '今天最让你笑的一刻?',
    '今天最让你皱眉的一刻?',
    '如果今天是一首歌, 它会是什么风格?',
    '你今天感谢了谁 (哪怕只在心里)?',
    '今天你看到的最美的东西是什么?',
    '今天你说出口最重要的一句话是?',
    '今天什么事让你觉得"哦, 原来是这样"?',
    '现在让你形容今天, 用一个词?',
    'What\'s on your mind right now?',
    'What\'s something small from today that lingers?',
    'What surprised you today?',
    'What\'s a question you\'re sitting with?',
  ],
};

/** Pick random prompt for a topic. Returns null if topic invalid. */
export function pickTopicPrompt(topicKey: string, exclude?: string): string | null {
  const bank = TOPIC_PROMPTS[topicKey];
  if (!bank || bank.length === 0) return null;
  if (bank.length === 1) return bank[0];
  // Pick different from `exclude` when re-rolling.
  let pick: string;
  let tries = 0;
  do {
    pick = bank[Math.floor(Math.random() * bank.length)];
    tries++;
  } while (exclude && pick === exclude && tries < 10);
  return pick;
}

/** Inline keyboard for prompt re-roll / skip after a topic prompt is shown. */
export function promptActionKeyboard(topicKey: string): any {
  return {
    inline_keyboard: [
      [
        { text: '🎲 换一个', callback_data: `prompt:reroll:${topicKey}` },
        { text: '💭 直接聊', callback_data: 'prompt:skip' },
      ],
    ],
  };
}
