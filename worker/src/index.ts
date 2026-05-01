// Cloudflare Worker: Telegram Webhook Relay + Message Router + AI Reply
// Unified architecture — both self-hosted and hosted modes use this worker.

import { pickTopicPrompt, promptActionKeyboard } from './prompts';
import { upsertEntityMention, recordCooccurrence, entityGraph, searchEntitiesByName, EntityMention } from './entitiesDb';
import { TOPICS, TOPIC_BY_KEY, topicKeyboard } from './topics';
import { summarizeConversation, persistFinalizePacket, drainFinalizePackets } from './finalize';
import { appendToBuffer, flushProfile, getProfile, setProfileFromUser, listProfiles } from './topicProfile';

export interface Env {
  MESSAGES: KVNamespace;
  BINDINGS: KVNamespace;
  /** D1 database for entities + mentions + cooccurrences. M3.1. */
  DB?: D1Database;
  BOT_TOKEN: string;
  DEEPSEEK_API_KEY?: string;
  /** Comma-separated TG user IDs allowed to receive AI replies. Optional. */
  ALLOWED_USER_IDS?: string;
}

const AI_SYSTEM_PROMPT = `
You are a quiet, warm diary companion — like a thoughtful friend, not a therapist.

REPLY STYLE — vary, don't always question:
- ~60% of turns: brief reflection (1-2 sentences) + ONE small question (≤15 words). Specific, not generic.
- ~25% of turns: pure empathy. Acknowledge feeling. NO question. Sit with the user. e.g. "听起来很累" / "That sounds heavy."
- ~15% of turns: gentle observation linking to past patterns. NO question. e.g. "You mentioned similar pressure last week — same shape?"

HARD RULES:
- Total reply ≤ 50 words. Usually shorter.
- Never offer advice unless explicitly asked.
- Match user's language exactly (Chinese / English / mixed). Mirror tone + formality.
- Don't echo user's words back verbatim.
- When a topic profile is provided, use it for nuance — don't recite it.
- Avoid "How does that make you feel?" type generic questions. Be specific.
`.trim();


const HELP_TEXT = `🤖 AI Diary Bot

Send any message. Pick a topic when prompted, or just talk.

Commands:
/chat — AI replies (default)
/silent — record only, no AI replies
/save — save current entry
/cancel — discard current entry
/onthisday — past entries on this day
/stats — writing stats
/ask <question> — ask anything about your diary
/search <name> — find a person / place / project
/help — this menu

Reports (daily/weekly/monthly) generate automatically when you open Obsidian.`;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; width: number; height: number }>;
    location?: { latitude: number; longitude: number };
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message?: { chat: { id: number } };
    data?: string;
  };
}

let webhookChecked = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Auto-re-register webhook on cold start (once per instance)
    if (!webhookChecked) {
      webhookChecked = true;
      try {
        const whRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
        const whData: any = await whRes.json();
        if (!whData?.result?.url) {
          console.log('webhook missing, re-registering...');
          const webhookUrl = `${new URL(request.url).origin}/webhook`;
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
        }
      } catch (e) {
        console.error('webhook auto-check failed', e);
      }
    }

    const url = new URL(request.url);

    // --- Telegram Webhook ---
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const update: TelegramUpdate = await request.json();
      return handleWebhook(update, env, ctx);
    }

    // --- Plugin pulls messages + AI context ---
    if (url.pathname === '/pull' && request.method === 'GET') {
      const userId = url.searchParams.get('user_id');
      const authHeader = request.headers.get('Authorization') || '';
      const headerToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : '';
      const token = headerToken || url.searchParams.get('token') || '';
      if (!userId || !token) {
        return json({ ok: false, error: 'Missing user_id or token' }, 400);
      }
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== userId) {
        return json({ ok: false, error: 'Invalid token' }, 403);
      }
      return handlePull(userId, env);
    }

    // --- Plugin sends TG message via worker ---
    if (url.pathname === '/send' && request.method === 'POST') {
      const body: any = await request.json();
      const { user_id, token, text, options, chat_action, callback_query_id, callback_text } = body || {};
      if (!user_id || !token) {
        return json({ ok: false, error: 'Missing user_id or token' }, 400);
      }
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== user_id) {
        return json({ ok: false, error: 'Invalid token' }, 403);
      }
      return handleSend(user_id, text, options, chat_action, callback_query_id, callback_text, env);
    }

    // --- Plugin pushes finalized entry → entity DB upsert (M3.4) ---
    if (url.pathname === '/index' && request.method === 'POST') {
      const body: any = await request.json();
      const { user_id, token, entry } = body || {};
      if (!user_id || !token || !entry) {
        return json({ ok: false, error: 'Missing user_id, token, or entry' }, 400);
      }
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== user_id) {
        return json({ ok: false, error: 'Invalid token' }, 403);
      }
      const { date, path: entryPath, mood, people, places, projects } = entry as any;
      if (!date) return json({ ok: false, error: 'Missing date' }, 400);

      const mentions: EntityMention[] = [];
      for (const p of (people || [])) mentions.push({ name: String(p), type: 'person', date, entry_path: entryPath, mood });
      for (const p of (places || [])) mentions.push({ name: String(p), type: 'place', date, entry_path: entryPath, mood });
      for (const p of (projects || [])) mentions.push({ name: String(p), type: 'project', date, entry_path: entryPath, mood });
      const ids: number[] = [];
      for (const m of mentions) {
        const id = await upsertEntityMention(user_id, m, env);
        if (id) ids.push(id);
      }
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          await recordCooccurrence(user_id, ids[i], ids[j], env);
        }
      }
      return json({ ok: true, entities: ids.length });
    }

    // --- Plugin lists topic profiles (sync to Topics/<key>.md) ---
    if (url.pathname === '/profiles' && request.method === 'GET') {
      const userId = url.searchParams.get('user_id') || '';
      const authHeader = request.headers.get('Authorization') || '';
      const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const token = headerToken || url.searchParams.get('token') || '';
      if (!userId || !token) return json({ ok: false, error: 'Missing user_id / token' }, 400);
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== userId) return json({ ok: false, error: 'Invalid token' }, 403);
      const list = await listProfiles(userId, env);
      return json({ ok: true, profiles: list });
    }

    // --- Plugin reverse-syncs user-edited topic profile from vault → D1 ---
    if (url.pathname === '/profile-update' && request.method === 'POST') {
      const body: any = await request.json();
      const { user_id, token, topic, profile, themes } = body || {};
      if (!user_id || !token || !topic) return json({ ok: false, error: 'Missing fields' }, 400);
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== user_id) return json({ ok: false, error: 'Invalid token' }, 403);
      if (!TOPIC_BY_KEY[topic]) return json({ ok: false, error: 'Unknown topic' }, 400);
      const ok = await setProfileFromUser(user_id, topic, String(profile || ''), Array.isArray(themes) ? themes : [], env);
      return json({ ok });
    }

    // --- Plugin queries entity graph (M3.4) ---
    if (url.pathname === '/graph' && request.method === 'GET') {
      const userId = url.searchParams.get('user_id') || '';
      const authHeader = request.headers.get('Authorization') || '';
      const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const token = headerToken || url.searchParams.get('token') || '';
      if (!userId || !token) return json({ ok: false, error: 'Missing user_id / token' }, 400);
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== userId) return json({ ok: false, error: 'Invalid token' }, 403);
      const data = await entityGraph(userId, env);
      return json({ ok: true, ...data });
    }

    // --- Plugin pushes user pref (replyMode, persona) — UI-toggle sync ---
    if (url.pathname === '/pref' && request.method === 'POST') {
      const body: any = await request.json();
      const { user_id, token, pref } = body || {};
      if (!user_id || !token || !pref) {
        return json({ ok: false, error: 'Missing user_id, token, or pref' }, 400);
      }
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== user_id) {
        return json({ ok: false, error: 'Invalid token' }, 403);
      }
      // Merge with existing pref to preserve worker-tracked fields (silentIndex etc).
      const existingRaw = await env.MESSAGES.get(`pref:${user_id}`);
      const existing = existingRaw ? JSON.parse(existingRaw) : {};
      const merged = { ...existing, ...pref };
      await env.MESSAGES.put(`pref:${user_id}`, JSON.stringify(merged), { expirationTtl: 2592000 });
      return json({ ok: true });
    }

    // --- Plugin pushes user profile ---
    if (url.pathname === '/profile' && request.method === 'POST') {
      const body: any = await request.json();
      const { user_id, token, profile } = body || {};
      if (!user_id || !token || !profile) {
        return json({ ok: false, error: 'Missing user_id, token, or profile' }, 400);
      }
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== user_id) {
        return json({ ok: false, error: 'Invalid token' }, 403);
      }
      await env.MESSAGES.put(`profile:${user_id}`, profile, { expirationTtl: 172800 });
      return json({ ok: true });
    }

    // --- Plugin marks session done — clear ctx + queue (start fresh next time) ---
    if (url.pathname === '/finish' && request.method === 'POST') {
      const body: any = await request.json();
      const { user_id, token } = body || {};
      if (!user_id || !token) {
        return json({ ok: false, error: 'Missing user_id or token' }, 400);
      }
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== user_id) {
        return json({ ok: false, error: 'Invalid token' }, 403);
      }
      await env.MESSAGES.delete(`ctx:${user_id}`);
      await env.MESSAGES.delete(`queue:${user_id}`);
      return json({ ok: true });
    }

    // --- Plugin downloads TG file via worker proxy (no bot token in plugin) ---
    if (url.pathname === '/file' && request.method === 'GET') {
      const fileId = url.searchParams.get('file_id');
      const userId = url.searchParams.get('user_id');
      const authHeader = request.headers.get('Authorization') || '';
      const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const token = headerToken || url.searchParams.get('token') || '';
      if (!fileId || !userId || !token) {
        return json({ ok: false, error: 'Missing file_id, user_id, or token' }, 400);
      }
      const storedUserId = await env.BINDINGS.get(`token:${token}`);
      if (storedUserId !== userId) {
        return json({ ok: false, error: 'Invalid token' }, 403);
      }
      try {
        const metaRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
        const metaJson: any = await metaRes.json();
        if (!metaJson?.ok || !metaJson.result?.file_path) {
          return json({ ok: false, error: 'getFile failed', detail: metaJson }, 502);
        }
        const fileRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${metaJson.result.file_path}`);
        if (!fileRes.ok) {
          return json({ ok: false, error: `file fetch ${fileRes.status}` }, 502);
        }
        return new Response(fileRes.body, {
          status: 200,
          headers: {
            'Content-Type': fileRes.headers.get('Content-Type') || 'application/octet-stream',
            'Content-Length': fileRes.headers.get('Content-Length') || '',
          },
        });
      } catch (e: any) {
        return json({ ok: false, error: e?.message || 'file proxy failed' }, 500);
      }
    }

    // --- Plugin checks binding status (legacy 6-digit code) ---
    if (url.pathname === '/bind-check' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) return json({ ok: false, error: 'Missing code' }, 400);
      const binding = await env.BINDINGS.get(`code:${code}`);
      if (binding) {
        const data = JSON.parse(binding);
        return json({ ok: true, user_id: data.user_id, token: data.token });
      }
      return json({ ok: false, bound: false });
    }

    // --- Deep-link onboarding: plugin generates token, opens t.me/<bot>?start=<token> ---
    if (url.pathname === '/bind-init' && request.method === 'POST') {
      const body: any = await request.json();
      const { token, vault_id } = body || {};
      if (!token || typeof token !== 'string' || token.length < 16 || token.length > 96) {
        return json({ ok: false, error: 'Missing or invalid token (16-96 chars)' }, 400);
      }
      if (!/^[A-Za-z0-9_-]+$/.test(token)) {
        return json({ ok: false, error: 'Token must be base64url' }, 400);
      }
      // Store pending bind. 5-min TTL; deleted on consume.
      await env.BINDINGS.put(
        `pending:${token}`,
        JSON.stringify({ vault_id: vault_id || null, created: Date.now() }),
        { expirationTtl: 300 }
      );
      return json({ ok: true });
    }

    // --- Plugin polls deep-link bind status ---
    if (url.pathname === '/bind-status' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) {
        return json({ ok: false, error: 'Invalid token' }, 400);
      }
      const completed = await env.BINDINGS.get(`bind-done:${token}`);
      if (completed) {
        const data = JSON.parse(completed);
        // Single-use: delete on read so polling stops + token can't be replayed.
        await env.BINDINGS.delete(`bind-done:${token}`);
        return json({ ok: true, bound: true, user_id: data.user_id, token: data.auth_token });
      }
      return json({ ok: true, bound: false });
    }

    // --- Setup: register webhook ---
    if (url.pathname === '/setup-webhook') {
      const webhookUrl = `${url.origin}/webhook`;
      const res = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
      );
      const data = await res.json();
      return json(data);
    }

    // --- Read raw KV for debugging ---
    if (url.pathname === '/kv-read') {
      const key = url.searchParams.get('key') || '';
      if (!key) return json({ error: 'Provide ?key=<kv-key>' }, 400);
      const val = await env.MESSAGES.get(key);
      return json({ key, found: !!val, value: val ? val.slice(0, 500) : null });
    }

    // --- Health check for plugin diagnostics ---
    if (url.pathname === '/health') {
      const out: any = {
        ok: true,
        bot_token_set: !!env.BOT_TOKEN,
        deepseek_key_set: !!env.DEEPSEEK_API_KEY,
        kv_messages_bound: !!env.MESSAGES,
        kv_bindings_bound: !!env.BINDINGS,
        webhook_url: null as string | null,
        webhook_ok: false,
        bot_username: null as string | null,
      };
      if (env.BOT_TOKEN) {
        try {
          const wh = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
          const whData: any = await wh.json();
          out.webhook_url = whData?.result?.url || null;
          out.webhook_ok = !!out.webhook_url;
        } catch (e: any) {
          out.webhook_error = e?.message || 'unknown';
        }
        try {
          const me = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`);
          const meData: any = await me.json();
          out.bot_username = meData?.result?.username || null;
        } catch { /* optional */ }
      }
      return json(out);
    }

    // --- Debug: check TG connectivity + KV test ---
    if (url.pathname === '/debug') {
      const chatId = url.searchParams.get('chat_id');
      const meRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`);
      const meData: any = await meRes.json();
      const webhookRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
      const webhookData: any = await webhookRes.json();

      // Test KV write
      await env.MESSAGES.put('debug:test', JSON.stringify({ time: Date.now() }), { expirationTtl: 60 });
      const kvRead = await env.MESSAGES.get('debug:test');

      // Test DeepSeek
      let dsResult: any = null;
      if (env.DEEPSEEK_API_KEY) {
        const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}` },
          body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 50, messages: [{ role: 'user', content: 'say hello' }] }),
        });
        dsResult = await dsRes.json();
      }

      let testResult: any = null;
      if (chatId) {
        const testRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: 'Debug test message from worker ✅' }),
        });
        testResult = await testRes.json();
      }
      return json({ bot: meData, webhook: webhookData, kv_write_test: kvRead ? 'OK' : 'FAIL', test_send: testResult, deepseek: dsResult?.choices?.[0]?.message?.content || dsResult?.error || 'no_key' });
    }

    return json({ ok: true, message: 'AI Diary Bot Relay' });
  },

};

async function handleWebhook(update: TelegramUpdate, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cq = update.callback_query;
  const msg = update.message;
  if (cq) {
    console.log('webhook callback', cq.from?.id, cq.data?.slice(0, 30));
  } else if (msg) {
    console.log('webhook msg', msg.from?.id, 'chat:', msg.chat?.id, 'text:', (msg.text || '').slice(0, 50));
  } else {
    console.log('webhook unknown', JSON.stringify(update).slice(0, 100));
  }

  // Callback query from inline keyboard — answer directly
  if (update.callback_query) {
    const cq = update.callback_query;
    const userId = cq.from.id.toString();
    const chatId = cq.message?.chat?.id?.toString() || userId;
    const data = cq.data || '';

    if (data === 'save') {
      await answerCallback(env.BOT_TOKEN, cq.id, 'Saving…');
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '📝 Open Obsidian to save your diary entry.');
    } else if (data === 'help') {
      await answerCallback(env.BOT_TOKEN, cq.id);
      await sendTelegramMessage(env.BOT_TOKEN, chatId, HELP_TEXT);
    } else if (data.startsWith('topic:')) {
      const topicKey = data.slice('topic:'.length);
      if (TOPIC_BY_KEY[topicKey]) {
        const prefKey = `pref:${userId}`;
        const prefRaw = await env.MESSAGES.get(prefKey);
        const pref = prefRaw ? JSON.parse(prefRaw) : {};
        pref.activeTopic = topicKey;
        pref.topicChosenAt = Date.now();
        await env.MESSAGES.put(prefKey, JSON.stringify(pref), { expirationTtl: 2592000 });
        await answerCallback(env.BOT_TOKEN, cq.id, `Topic: ${topicKey}`);
        const t = TOPIC_BY_KEY[topicKey];
        const prompt = pickTopicPrompt(topicKey) || `${t.zh} / ${t.en}`;
        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          `${t.emoji} *${t.zh} / ${t.en}*\n\n${prompt}`,
          'Markdown',
          promptActionKeyboard(topicKey)
        );
      } else {
        await answerCallback(env.BOT_TOKEN, cq.id, 'Unknown topic.');
      }
    } else if (data.startsWith('prompt:reroll:')) {
      const topicKey = data.slice('prompt:reroll:'.length);
      if (TOPIC_BY_KEY[topicKey]) {
        // Try to extract previous prompt from message text to avoid repeat.
        const prevText = cq.message?.text || '';
        const prevPrompt = prevText.split('\n').slice(2).join('\n').trim();
        const next = pickTopicPrompt(topicKey, prevPrompt);
        await answerCallback(env.BOT_TOKEN, cq.id, '🎲');
        const t = TOPIC_BY_KEY[topicKey];
        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          `${t.emoji} *${t.zh} / ${t.en}*\n\n${next}`,
          'Markdown',
          promptActionKeyboard(topicKey)
        );
      } else {
        await answerCallback(env.BOT_TOKEN, cq.id, 'Unknown topic.');
      }
    } else if (data === 'prompt:skip') {
      await answerCallback(env.BOT_TOKEN, cq.id, 'OK');
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '💭 想说什么都行。');
    } else if (data.startsWith('mode:')) {
      const mode = data.slice('mode:'.length);
      if (mode === 'silent' || mode === 'conversation') {
        const prefKey = `pref:${userId}`;
        const prefRaw = await env.MESSAGES.get(prefKey);
        const pref = prefRaw ? JSON.parse(prefRaw) : {};
        pref.replyMode = mode;
        await env.MESSAGES.put(prefKey, JSON.stringify(pref), { expirationTtl: 2592000 });
        await answerCallback(env.BOT_TOKEN, cq.id, `Mode: ${mode}`);
        const label = mode === 'silent' ? '🤫 Silent — record-only' : '💬 Conversation — AI reflection';
        await sendTelegramMessage(env.BOT_TOKEN, chatId, label);
      } else {
        await answerCallback(env.BOT_TOKEN, cq.id, 'Unknown mode.');
      }
    } else {
      await answerCallback(env.BOT_TOKEN, cq.id);
    }

    // Still queue for plugin in case Obsidian is open
    const queueKey2 = `queue:${userId}`;
    const existing2 = await env.MESSAGES.get(queueKey2);
    const queue2: any[] = existing2 ? JSON.parse(existing2) : [];
    queue2.push({ callback_query: cq, date: Math.floor(Date.now() / 1000) });
    await env.MESSAGES.put(queueKey2, JSON.stringify(queue2.slice(-200)), { expirationTtl: 604800 });
    return json({ ok: true });
  }

  if (!msg || !msg.from) return json({ ok: true });

  const userId = msg.from.id.toString();
  const chatId = msg.chat.id.toString();
  const text = msg.text || msg.caption || '';

  // Handle /start [payload] — payload comes from t.me/<bot>?start=<token> deep link.
  if (text === '/start' || text.startsWith('/start ')) {
    const payload = text.length > 7 ? text.slice(7).trim() : '';
    if (payload && /^[A-Za-z0-9_-]+$/.test(payload) && payload.length >= 16 && payload.length <= 96) {
      // Deep-link path: consume pending token, mark bind-done for plugin to pick up.
      const pendingRaw = await env.BINDINGS.get(`pending:${payload}`);
      if (pendingRaw) {
        const authToken = crypto.randomUUID();
        await env.BINDINGS.put(`token:${authToken}`, userId);
        await env.BINDINGS.put(
          `bind-done:${payload}`,
          JSON.stringify({ user_id: userId, auth_token: authToken }),
          { expirationTtl: 300 }
        );
        await env.BINDINGS.delete(`pending:${payload}`);
        await sendTelegramMessage(env.BOT_TOKEN, chatId,
          `✅ *Connected.*\n\nNow try this:\n\n1️⃣ Send any message (e.g. _hello_)\n2️⃣ Pick a topic when I ask\n3️⃣ Chat → send /save to commit to today's note\n\n/help for everything else.`,
          'Markdown'
        );
        return json({ ok: true });
      }
      // Token not found / expired
      await sendTelegramMessage(env.BOT_TOKEN, chatId,
        '⌛ This connect link has expired. Open Obsidian plugin settings and click "Connect Telegram" again to get a fresh link.'
      );
      return json({ ok: true });
    }
    // No payload — check if user already bound.
    const alreadyBound = await env.BINDINGS.get(`token:any`); // sentinel check unused
    const knownUser = await env.MESSAGES.get(`pref:${userId}`);
    if (knownUser) {
      // Returning user: short walk-through.
      await sendTelegramMessage(env.BOT_TOKEN, chatId,
        '👋 *Welcome back.*\n\n3-step flow:\n1. Send any message — I\'ll ask you to pick a topic\n2. Chat as long as you want\n3. Send /save to write to your diary\n\nUse /help anytime for the full list.',
        'Markdown'
      );
    } else {
      // New user: full onboarding.
      await sendTelegramMessage(env.BOT_TOKEN, chatId,
        '👋 *Hi! I\'m your diary companion.*\n\nI capture what you write here and turn it into structured Markdown notes in your Obsidian vault.\n\n*Quick start (3 steps):*\n\n1️⃣ Open the Obsidian plugin settings → click "Connect Telegram" → tap the link it opens.\n2️⃣ Send me any message here. I\'ll show you topic buttons (work / friend / family / etc).\n3️⃣ Chat naturally. When done, send /save — I\'ll save the entry to today\'s note.\n\n_That\'s it. /help for more commands._',
        'Markdown'
      );
    }
    return json({ ok: true });
  }

  // Handle /bind command — lenient: accept /bind 123456, /bind123456, /bind\n123456
  const bindMatch = text.match(/^\/bind[\s_-]*(\d{4,8})\s*$/i);
  if (text === '/bind' || text.startsWith('/bind') && /\d/.test(text)) {
    if (!bindMatch) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId,
        'Usage: send `/bind 123456` (the 6-digit code from your Obsidian plugin settings).');
      return json({ ok: true });
    }
    const code = bindMatch[1];
    if (code.length < 4) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '❌ Invalid code. Please check and try again.');
      return json({ ok: true });
    }

    const token = crypto.randomUUID();
    await env.BINDINGS.put(`code:${code}`, JSON.stringify({ user_id: userId, token }), { expirationTtl: 600 });
    await env.BINDINGS.put(`token:${token}`, userId);

    await sendTelegramMessage(env.BOT_TOKEN, chatId,
      `✅ Binding successful! Your Obsidian plugin should connect automatically.\n\nYour Telegram ID: ${userId}\nYou can now start sending diary messages here!`
    );
    return json({ ok: true });
  }

  // --- Commands the worker handles directly (no vault needed) ---

  if (text === '/help') {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, HELP_TEXT);
    return json({ ok: true });
  }

  if (text === '/chat' || text === '/silent') {
    const mode = text === '/silent' ? 'silent' : 'conversation';
    const prefKey = `pref:${userId}`;
    const prefRaw = await env.MESSAGES.get(prefKey);
    const pref = prefRaw ? JSON.parse(prefRaw) : {};
    pref.replyMode = mode;
    // Reset session state so /chat starts a clean conversation.
    delete pref.activeTopic;
    delete pref.topicChosenAt;
    await env.MESSAGES.put(prefKey, JSON.stringify(pref), { expirationTtl: 2592000 });
    await env.MESSAGES.delete(`ctx:${userId}`);
    if (mode === 'silent') {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '🤫 Silent — record only, no AI');
    } else {
      await sendTelegramMessage(
        env.BOT_TOKEN,
        chatId,
        '💬 Chat enabled. What do you want to talk about?',
        undefined,
        topicKeyboard()
      );
    }
    return json({ ok: true });
  }
  // Legacy /mode kept as silent fallback (button picker).
  if (text === '/mode') {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, 'Pick a mode:', undefined, modeKeyboard());
    return json({ ok: true });
  }

  if (text.startsWith('/search ')) {
    const q = text.replace('/search ', '').trim();
    if (!q) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, 'Usage: /search <person | place | project>');
      return json({ ok: true });
    }
    const matches = await searchEntitiesByName(userId, q, env);
    if (matches.length === 0) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId,
        `🔍 No entity matches "${q}".\n\nFor full-text search of entry content, use Obsidian's Ctrl+Shift+F.`
      );
      return json({ ok: true });
    }
    const lines = matches.slice(0, 5).map((e, i) => {
      const icon = e.type === 'person' ? '👤' : e.type === 'place' ? '📍' : '📁';
      return `${i + 1}. ${icon} *${e.name}* — ${e.mention_count} mention${e.mention_count === 1 ? '' : 's'} · last ${e.last_seen}`;
    });
    await sendTelegramMessage(env.BOT_TOKEN, chatId,
      `🔍 *Entities matching*: _${q.replace(/[*_`]/g, '')}_\n\n${lines.join('\n')}\n\n_Open Obsidian's People Graph for the full picture._`,
      'Markdown'
    );
    return json({ ok: true });
  }

  // Cloud-side /save (legacy /done): AI summarize → D1 finalize_packets + topic profile buffer.
  // Plugin's /pull picks up packet later and writes vault. User gets immediate "✓ Saved".
  if (text === '/save' || text === '/done') {
    const ctxRaw = await env.MESSAGES.get(`ctx:${userId}`);
    const conversation: Array<{ role: 'user' | 'assistant'; content: string }> =
      ctxRaw ? JSON.parse(ctxRaw) : [];
    const photosKey = `pending-photos:${userId}`;
    const photosRaw = await env.MESSAGES.get(photosKey);
    const photoIdsPending: string[] = photosRaw ? JSON.parse(photosRaw) : [];
    if (conversation.length === 0 && photoIdsPending.length === 0) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, 'No conversation to save.');
      return json({ ok: true });
    }
    // Photo-only entry: synthesize minimal conversation so AI summarize has input.
    if (conversation.length === 0 && photoIdsPending.length > 0) {
      conversation.push({ role: 'user', content: `[Shared ${photoIdsPending.length} photo${photoIdsPending.length === 1 ? '' : 's'} without caption]` });
    }
    const prefRawDone = await env.MESSAGES.get(`pref:${userId}`);
    const prefDone = prefRawDone ? JSON.parse(prefRawDone) : {};
    const activeTopic: string | null = prefDone.activeTopic || null;
    const topicProfile = activeTopic && activeTopic !== 'random'
      ? (await getProfile(userId, activeTopic, env)).user_profile || null
      : null;

    await sendTelegramMessage(env.BOT_TOKEN, chatId, '🌙 Saving…');
    const parsed = await summarizeConversation(conversation, topicProfile, env);
    if (!parsed) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '⚠️ Save failed (AI unavailable). Try /done again or open Obsidian.');
      return json({ ok: true });
    }
    // Inject topic into frontmatter.topics if not already present (canonical key).
    if (activeTopic && Array.isArray(parsed.frontmatter.topics)) {
      const lower = activeTopic.toLowerCase();
      if (!parsed.frontmatter.topics.some((t: string) => String(t).toLowerCase() === lower)) {
        parsed.frontmatter.topics.unshift(activeTopic);
      }
    } else if (activeTopic) {
      parsed.frontmatter.topics = [activeTopic];
    }

    const today = new Date().toISOString().slice(0, 10);
    await persistFinalizePacket(userId, today, activeTopic, parsed, conversation, photoIdsPending, env);
    // Drain pending photos.
    if (photoIdsPending.length > 0) {
      await env.MESSAGES.delete(photosKey);
    }

    // Append to topic buffer + maybe schedule async flush.
    if (activeTopic && activeTopic !== 'random') {
      const entrySummary = `mood: ${parsed.frontmatter.mood || 'n/a'} · ${parsed.body.replace(/\s+/g, ' ').slice(0, 400)}`;
      const { shouldFlush } = await appendToBuffer(userId, activeTopic, entrySummary, env);
      if (shouldFlush) {
        ctx.waitUntil(flushProfile(userId, activeTopic, env));
      }
    }

    // Clear ctx so next session is fresh; reset activeTopic so user gets topic picker again.
    await env.MESSAGES.delete(`ctx:${userId}`);
    if (prefDone) {
      delete prefDone.activeTopic;
      delete prefDone.topicChosenAt;
      await env.MESSAGES.put(`pref:${userId}`, JSON.stringify(prefDone), { expirationTtl: 2592000 });
    }

    const tagsLine = Array.isArray(parsed.frontmatter.topics) && parsed.frontmatter.topics.length
      ? `\nTags: ${parsed.frontmatter.topics.map((t: string) => `#${t}`).join(' ')}`
      : '';
    await sendTelegramMessage(env.BOT_TOKEN, chatId,
      `✓ Saved.${tagsLine}\n\n_Open Obsidian when convenient. Send a new message anytime to start the next entry._`,
      'Markdown'
    );
    return json({ ok: true });
  }
  if (text === '/cancel') {
    await env.MESSAGES.delete(`queue:${userId}`);
    await sendTelegramMessage(env.BOT_TOKEN, chatId, '✓ Current session discarded.');
    return json({ ok: true });
  }
  if (text === '/stats') {
    await sendTelegramMessage(env.BOT_TOKEN, chatId,
      '📊 Open Obsidian to see your diary stats. (Plugin computes from vault data.)'
    );
    return json({ ok: true });
  }
  if (text === '/onthisday') {
    await sendTelegramMessage(env.BOT_TOKEN, chatId,
      '📅 Open Obsidian to look up past entries from this day.'
    );
    return json({ ok: true });
  }
  if (text === '/dashboard') {
    await sendTelegramMessage(env.BOT_TOKEN, chatId,
      '📊 Open Obsidian and click the 📊 ribbon icon to see your dashboard.'
    );
    return json({ ok: true });
  }

  // Handle /ask — quick response when Obsidian may be closed
  if (text.startsWith('/ask')) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId,
      '📊 I need to read your diary files to answer that. Open Obsidian and I\'ll look it up for you!'
    );
    // Fall through to queue — plugin will process when online
  }

  // New-session detect: trigger topic picker when:
  //   - no active topic AND no ctx, OR
  //   - last activity > 2h ago (idle session reset).
  // Skip for slash commands and silent mode.
  {
    const prefRaw0 = await env.MESSAGES.get(`pref:${userId}`);
    const pref0 = prefRaw0 ? JSON.parse(prefRaw0) : {};
    const hasActive = !!pref0.activeTopic;
    const ctxRaw0 = await env.MESSAGES.get(`ctx:${userId}`);
    const ctxLen = ctxRaw0 ? (JSON.parse(ctxRaw0) as any[]).length : 0;
    const lastTs: number = pref0.lastActivityTs || 0;
    const idleHours = (Date.now() - lastTs) / 36e5;
    const isIdleReset = lastTs > 0 && idleHours > 2;
    const shouldPick = (!hasActive && ctxLen === 0) || isIdleReset;
    if (isIdleReset) {
      // Reset stale state.
      delete pref0.activeTopic;
      delete pref0.topicChosenAt;
      await env.MESSAGES.delete(`ctx:${userId}`);
    }
    pref0.lastActivityTs = Date.now();
    await env.MESSAGES.put(`pref:${userId}`, JSON.stringify(pref0), { expirationTtl: 2592000 });
    if (shouldPick && text && !text.startsWith('/') && pref0.replyMode !== 'silent') {
      // Stash the user msg in ctx so they don't have to retype after picking topic.
      const initialCtx = [{ role: 'user', content: text }];
      await env.MESSAGES.put(`ctx:${userId}`, JSON.stringify(initialCtx), { expirationTtl: 86400 });
      await sendTelegramMessage(
        env.BOT_TOKEN,
        chatId,
        '🌱 What do you want to talk about? (You can pick once per session.)',
        undefined,
        topicKeyboard()
      );
      // Queue msg + return — AI reply waits until topic picked.
      const queueKeyN = `queue:${userId}`;
      const existingN = await env.MESSAGES.get(queueKeyN);
      const queueN: any[] = existingN ? JSON.parse(existingN) : [];
      queueN.push({
        message_id: msg.message_id,
        from: msg.from,
        date: msg.date,
        text: msg.text || null,
        caption: msg.caption || null,
        photo: msg.photo || null,
        location: msg.location || null,
        worker_replied: true, // suppress plugin AI; we're awaiting topic pick
      });
      await env.MESSAGES.put(queueKeyN, JSON.stringify(queueN.slice(-200)), { expirationTtl: 604800 });
      return json({ ok: true, awaiting_topic: true });
    }
  }

  // Worker is always the canonical AI replier. Plugin reads worker_replied flag and skips
  // its own AI to avoid double-reply. Plugin still pulls queue for vault persistence.
  let aiStatus = 'skipped';
  let aiReply = '';
  let workerReplied = false;
  if (text && !text.startsWith('/') && env.DEEPSEEK_API_KEY && isAllowedForAI(userId, env)) {
    aiStatus = 'attempted';
    try {
      await replyWithAI(userId, chatId, text, env, msg.message_id);
      aiStatus = 'sent';
      workerReplied = true;
      const ctxAfter = await env.MESSAGES.get(`ctx:${userId}`);
      aiReply = ctxAfter ? 'ctx stored' : 'ctx empty';
    } catch (e: any) {
      aiStatus = 'error:' + (e?.message || 'unknown');
      console.error('AI reply error', e?.message || e);
    }
  }

  // Track photos for cloud-side /save (so finalize packet includes embeds).
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const photosKey = `pending-photos:${userId}`;
    const existingPhotos = await env.MESSAGES.get(photosKey);
    const photoList: string[] = existingPhotos ? JSON.parse(existingPhotos) : [];
    photoList.push(largest.file_id);
    await env.MESSAGES.put(photosKey, JSON.stringify(photoList.slice(-50)), { expirationTtl: 86400 });
    // Append placeholder to ctx if no text/caption — so /save sees content.
    if (!text) {
      const ctxKeyPhoto = `ctx:${userId}`;
      const ctxRawPhoto = await env.MESSAGES.get(ctxKeyPhoto);
      const ctxArr: any[] = ctxRawPhoto ? JSON.parse(ctxRawPhoto) : [];
      ctxArr.push({ role: 'user', content: '[shared a photo]' });
      await env.MESSAGES.put(ctxKeyPhoto, JSON.stringify(ctxArr.slice(-20)), { expirationTtl: 86400 });
      // Ack the photo so user knows it was received (caption photos already get
      // text ack via replyWithAI path).
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '📝 Photo recorded.');
    }
  }

  // Queue message for plugin — but skip photo-only msgs (cloud-side path: photos
  // flow via pending-photos KV → /save finalize packet, plugin embeds via /file).
  // Skipping prevents plugin's silent-mode duplicate replies and double-write.
  if (!msg.photo) {
    const queueKey = `queue:${userId}`;
    const existing = await env.MESSAGES.get(queueKey);
    const queue: any[] = existing ? JSON.parse(existing) : [];

    queue.push({
      message_id: msg.message_id,
      from: msg.from,
      date: msg.date,
      text: msg.text || null,
      caption: msg.caption || null,
      photo: null,
      location: msg.location || null,
      worker_replied: workerReplied,
    });

    const trimmed = queue.slice(-200);
    await env.MESSAGES.put(queueKey, JSON.stringify(trimmed), { expirationTtl: 604800 });
  }

  return json({
    ok: true,
    ai: aiStatus,
    ai_reply: aiReply,
  });
}

function isAllowedForAI(userId: string, env: Env): boolean {
  if (!env.ALLOWED_USER_IDS) return true;
  const list = env.ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(userId);
}

async function replyWithAI(userId: string, chatId: string, text: string, env: Env, messageId?: number): Promise<void> {
  try {
    // Read user preferences
    const prefRaw = await env.MESSAGES.get(`pref:${userId}`);
    const pref = prefRaw ? JSON.parse(prefRaw) : {};

    // Silent mode — record user msg into ctx (for /done to save) + minimal ack.
    if (pref.replyMode === 'silent') {
      if (text) {
        const ctxKey = `ctx:${userId}`;
        const ctxRaw = await env.MESSAGES.get(ctxKey);
        const ctxArr: Array<{ role: 'user' | 'assistant'; content: string }> =
          ctxRaw ? JSON.parse(ctxRaw) : [];
        ctxArr.push({ role: 'user', content: text });
        await env.MESSAGES.put(ctxKey, JSON.stringify(ctxArr.slice(-30)), { expirationTtl: 86400 });
      }
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '📝 Recorded.');
      return;
    }

    const ctxKey = `ctx:${userId}`;
    const ctxRaw = await env.MESSAGES.get(ctxKey);
    const ctx: Array<{ role: 'user' | 'assistant'; content: string }> =
      ctxRaw ? JSON.parse(ctxRaw) : [];

    ctx.push({ role: 'user', content: text });

    // Build system prompt: unified companion + active topic profile (D1) + legacy KV memory.
    const activeTopic: string | null = pref.activeTopic || null;
    let topicProfileBlock = '';
    if (activeTopic && activeTopic !== 'random') {
      const tp = await getProfile(userId, activeTopic, env);
      if (tp.user_profile) {
        const themesList = tp.themes.length ? `\nRecurring patterns:\n${tp.themes.map((t: string) => `- ${t}`).join('\n')}` : '';
        topicProfileBlock = `\n\n## User profile in topic "${activeTopic}" (${tp.mention_count} entries)\n${tp.user_profile}${themesList}\n\nUse this context for nuance — don't recite it.`;
      }
    }
    const profileRaw = await env.MESSAGES.get(`profile:${userId}`);
    const memoryBlock = profileRaw
      ? `\n\n## Recent diary cues (last 7 days summary)\n${profileRaw}`
      : '';
    const systemPrompt = AI_SYSTEM_PROMPT + topicProfileBlock + memoryBlock;

    const aiRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 300,
        messages: [
          { role: 'system', content: systemPrompt },
          ...ctx.slice(-6),
        ],
      }),
    });

    if (!aiRes.ok) {
      console.error('DeepSeek non-200', aiRes.status, await aiRes.text());
      return;
    }
    const aiJson: any = await aiRes.json();
    const reply: string = aiJson.choices?.[0]?.message?.content?.trim() || '';
    if (!reply) return;

    ctx.push({ role: 'assistant', content: reply });
    await env.MESSAGES.put(ctxKey, JSON.stringify(ctx.slice(-10)), {
      expirationTtl: 86400,
    });
    // Try Markdown first, fall back to plain text if TG rejects
    const mdRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'Markdown', reply_markup: replyKeyboard() }),
    });
    const mdData: any = await mdRes.json();
    if (!mdData.ok) {
      console.error('TG Markdown send failed, retrying plain', JSON.stringify(mdData));
      await sendTelegramMessage(env.BOT_TOKEN, chatId, reply, undefined, replyKeyboard());
    }
  } catch (e: any) {
    console.error('AI reply failed', e?.message || e, e?.stack || '');
  }
}

async function handlePull(userId: string, env: Env): Promise<Response> {
  const queueKey = `queue:${userId}`;
  const existing = await env.MESSAGES.get(queueKey);
  const messages = existing ? JSON.parse(existing) : [];

  // Fetch AI context so plugin can reconstruct full conversation
  const ctxKey = `ctx:${userId}`;
  const ctxRaw = await env.MESSAGES.get(ctxKey);
  const aiContext: any[] = ctxRaw ? JSON.parse(ctxRaw) : [];

  // Drain finalize packets — cloud-side /done outputs.
  const finalize = await drainFinalizePackets(userId, env);

  // Clear queue after pull. Keep ctx — it's the canonical conversation history
  // worker uses to maintain AI continuity across multiple user msgs in a session.
  // ctx is cleared on /done, /cancel, or 'save' callback (session boundary).
  if (messages.length > 0) {
    await env.MESSAGES.delete(queueKey);
  }

  return json({ ok: true, messages, ai_context: aiContext, finalize });
}

async function handleSend(
  userId: string,
  text?: string,
  options?: { parse_mode?: string; reply_markup?: any },
  chatAction?: string,
  callbackQueryId?: string,
  callbackText?: string,
  env?: Env
): Promise<Response> {
  if (!env) return json({ ok: false, error: 'No env' }, 500);

  // Answer callback query
  if (callbackQueryId) {
    const body: any = { callback_query_id: callbackQueryId };
    if (callbackText) body.text = callbackText;
    try {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error('answerCallbackQuery failed', e);
    }
    return json({ ok: true });
  }

  // Send chat action
  if (chatAction) {
    try {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, action: chatAction }),
      });
    } catch (e) {
      console.error('sendChatAction failed', e);
    }
    return json({ ok: true });
  }

  // Send message
  if (text) {
    const msgBody: any = { chat_id: userId, text };
    if (options?.parse_mode) msgBody.parse_mode = options.parse_mode;
    if (options?.reply_markup) msgBody.reply_markup = options.reply_markup;
    try {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msgBody),
      });
    } catch (e) {
      console.error('sendMessage failed', e);
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Nothing to send' }, 400);
}

async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  parseMode?: string,
  replyMarkup?: any
) {
  const body: any = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!data.ok) {
    console.error('TG sendMessage failed', JSON.stringify({ status: res.status, body: data, chatId }));
  }
}

async function setMessageReaction(token: string, chatId: string, messageId: number, emoji: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      }),
    });
    const data: any = await res.json();
    if (!data.ok) console.error('TG setMessageReaction failed', JSON.stringify({ status: res.status, body: data }));
  } catch (e) {
    console.error('TG setMessageReaction error', e);
  }
}

async function answerCallback(token: string, callbackQueryId: string, text?: string) {
  const body: any = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function replyKeyboard(): any {
  return {
    inline_keyboard: [
      [
        { text: '✓ Save', callback_data: 'save' },
        { text: '❓ Help', callback_data: 'help' },
      ],
    ],
  };
}

function modeKeyboard(): any {
  return {
    inline_keyboard: [
      [
        { text: '💬 Chat', callback_data: 'mode:conversation' },
        { text: '🤫 Silent', callback_data: 'mode:silent' },
      ],
    ],
  };
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
