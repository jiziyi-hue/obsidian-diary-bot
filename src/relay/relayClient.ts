import { requestUrl } from 'obsidian';
import type { ReplyMarkup } from '../telegram/messageHandler';
import type DiaryBotPlugin from '../main';

export interface PullResult {
  messages: any[];
  aiContext: Array<{ role: 'user' | 'assistant'; content: string }>;
  finalize?: FinalizePacket[];
}

export interface FinalizePacket {
  id: number;
  date: string;
  topic: string | null;
  frontmatter: Record<string, any>;
  body: string;
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
  photo_ids: string[];
}

export class RelayClient {
  private plugin: DiaryBotPlugin | null = null;
  private relayUrl: string = '';
  private userId: string | null = null;
  private authToken: string | null = null;
  private isPolling: boolean = false;
  private messageListeners: Array<(msg: any) => void> = [];
  private callbackListeners: Array<(cq: any) => void> = [];
  private finalizeListeners: Array<(packet: FinalizePacket) => void> = [];
  private lastAiContext: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  // Track processed message_ids to skip duplicates from KV-eventually-consistent reads.
  // Bounded LRU-ish — keep the last 500 ids.
  private processedMessageIds: Set<number> = new Set();
  private processedOrder: number[] = [];

  constructor(plugin?: DiaryBotPlugin) {
    this.plugin = plugin || null;
  }

  isRunning(): boolean {
    return this.isPolling;
  }

  setRelayUrl(url: string) {
    if (url) this.relayUrl = url.replace(/\/$/, '');
  }

  setCredentials(userId: string, authToken: string) {
    this.userId = userId;
    this.authToken = authToken;
  }

  on(event: 'message' | 'callback_query' | 'finalize', listener: (msg: any) => void) {
    if (event === 'message') {
      this.messageListeners.push(listener);
    } else if (event === 'finalize') {
      this.finalizeListeners.push(listener);
    } else {
      this.callbackListeners.push(listener);
    }
  }

  async startPolling() {
    if (!this.relayUrl || !this.userId || !this.authToken) return;
    this.isPolling = true;
    this.poll();
  }

  stopPolling() {
    this.isPolling = false;
  }

  generateBindCode(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /** Hit /health on the worker. Returns null if unreachable. */
  async checkHealth(relayUrl?: string): Promise<{
    bot_token_set: boolean;
    deepseek_key_set: boolean;
    kv_messages_bound: boolean;
    kv_bindings_bound: boolean;
    webhook_url: string | null;
    webhook_ok: boolean;
    bot_username?: string | null;
  } | null> {
    const url = (relayUrl || this.relayUrl).replace(/\/$/, '');
    if (!url) return null;
    try {
      const res = await requestUrl({ url: `${url}/health`, method: 'GET' });
      if (res.status === 200 && res.json?.ok) return res.json;
    } catch { /* unreachable */ }
    return null;
  }

  /** Generate a fresh 32-byte token, register on worker, return token + bot deep-link URL. */
  async initDeepLinkBind(botUsername: string, vaultId?: string): Promise<{ token: string; url: string } | null> {
    const token = generateBase64UrlToken(32);
    try {
      const res = await requestUrl({
        url: `${this.relayUrl}/bind-init`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, vault_id: vaultId || null }),
      });
      if (res.status === 200 && res.json?.ok) {
        const url = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;
        return { token, url };
      }
      console.error('Diary Bot: /bind-init non-ok', res.status, res.json);
    } catch (e) {
      console.error('Diary Bot: /bind-init failed', e);
    }
    return null;
  }

  /** Poll deep-link bind status. Returns credentials once user completes /start in TG. */
  async pollBindStatus(token: string): Promise<{ user_id: string; token: string } | null> {
    try {
      const res = await requestUrl({
        url: `${this.relayUrl}/bind-status?token=${encodeURIComponent(token)}`,
        method: 'GET',
      });
      if (res.status === 200 && res.json?.bound) {
        return { user_id: res.json.user_id, token: res.json.token };
      }
    } catch { /* not bound yet / network — caller retries */ }
    return null;
  }

  async checkBinding(code: string): Promise<{ user_id: string; token: string } | null> {
    try {
      const res = await requestUrl({
        url: `${this.relayUrl}/bind-check?code=${encodeURIComponent(code)}`,
        method: 'GET',
      });
      if (res.status === 200 && res.json.ok && res.json.user_id) {
        return { user_id: res.json.user_id, token: res.json.token };
      }
    } catch { /* not bound yet */ }
    return null;
  }

  /** Send a TG message via worker /send. */
  async sendMessage(
    userId: string,
    text: string,
    options?: { parse_mode?: string; reply_markup?: ReplyMarkup }
  ): Promise<void> {
    if (!this.authToken) return;
    try {
      await requestUrl({
        url: `${this.relayUrl}/send`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ user_id: userId, token: this.authToken, text, options }),
      });
    } catch (e) {
      console.error('Diary Bot: /send failed', e);
    }
  }

  /** Send a chat action via worker. */
  async sendChatAction(userId: string, action: string): Promise<void> {
    if (!this.authToken) return;
    try {
      await requestUrl({
        url: `${this.relayUrl}/send`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ user_id: userId, token: this.authToken, chat_action: action }),
      });
    } catch (e) {
      console.error('Diary Bot: /send chat_action failed', e);
    }
  }

  /** Answer a callback query via worker. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.authToken) return;
    try {
      await requestUrl({
        url: `${this.relayUrl}/send`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ user_id: this.userId, token: this.authToken, callback_query_id: callbackQueryId, callback_text: text }),
      });
    } catch (e) {
      console.error('Diary Bot: answerCallbackQuery failed', e);
    }
  }

  /** Tell worker session is done (after finishSession). Clears ctx + queue. */
  async finishSession(userId: string): Promise<void> {
    if (!this.authToken) return;
    try {
      await requestUrl({
        url: `${this.relayUrl}/finish`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ user_id: userId, token: this.authToken }),
      });
    } catch (e) {
      console.error('Diary Bot: /finish failed', e);
    }
  }

  /** Download a Telegram file (photo/voice/etc) via worker proxy.
   *  Returns the binary or null on failure. */
  async downloadFile(userId: string, fileId: string): Promise<ArrayBuffer | null> {
    if (!this.authToken) return null;
    try {
      const res = await requestUrl({
        url: `${this.relayUrl}/file?user_id=${encodeURIComponent(userId)}&file_id=${encodeURIComponent(fileId)}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.authToken}` },
      });
      if (res.status === 200 && res.arrayBuffer) return res.arrayBuffer;
      console.error('Diary Bot: /file non-200', res.status);
    } catch (e) {
      console.error('Diary Bot: /file failed', e);
    }
    return null;
  }

  /** Push finalized entry → worker upserts entity DB (people graph + reminders). */
  async indexEntry(userId: string, entry: {
    date: string; path?: string; mood?: string;
    people?: string[]; places?: string[]; projects?: string[];
  }): Promise<void> {
    if (!this.authToken) return;
    try {
      await requestUrl({
        url: `${this.relayUrl}/index`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ user_id: userId, token: this.authToken, entry }),
      });
    } catch (e) {
      console.error('Diary Bot: indexEntry failed', e);
    }
  }

  /** List all topic profiles for the bound user. */
  async fetchTopicProfiles(userId: string): Promise<Array<{ topic: string; user_profile: string; themes: string[]; mention_count: number; last_updated: string | null }>> {
    if (!this.authToken) return [];
    try {
      const res = await requestUrl({
        url: `${this.relayUrl}/profiles?user_id=${encodeURIComponent(userId)}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.authToken}` },
      });
      if (res.status === 200 && res.json?.ok) return res.json.profiles || [];
    } catch (e) {
      console.error('Diary Bot: fetchTopicProfiles failed', e);
    }
    return [];
  }

  /** Reverse-sync user's edited topic profile back to worker D1. */
  async pushTopicProfile(userId: string, topic: string, profile: string, themes: string[]): Promise<boolean> {
    if (!this.authToken) return false;
    try {
      const res = await requestUrl({
        url: `${this.relayUrl}/profile-update`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ user_id: userId, token: this.authToken, topic, profile, themes }),
      });
      return res.status === 200 && res.json?.ok === true;
    } catch (e) {
      console.error('Diary Bot: pushTopicProfile failed', e);
      return false;
    }
  }

  /** Fetch entity graph nodes + edges. */
  async fetchEntityGraph(userId: string): Promise<{ nodes: any[]; edges: any[] }> {
    if (!this.authToken) return { nodes: [], edges: [] };
    try {
      const res = await requestUrl({
        url: `${this.relayUrl}/graph?user_id=${encodeURIComponent(userId)}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.authToken}` },
      });
      if (res.status === 200 && res.json?.ok) {
        return { nodes: res.json.nodes || [], edges: res.json.edges || [] };
      }
    } catch (e) {
      console.error('Diary Bot: fetchEntityGraph failed', e);
    }
    return { nodes: [], edges: [] };
  }

  /** Push user pref (replyMode, persona) to worker — keeps UI toggle in sync. */
  async pushPref(userId: string, pref: Record<string, any>): Promise<void> {
    if (!this.authToken) return;
    try {
      await requestUrl({
        url: `${this.relayUrl}/pref`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ user_id: userId, token: this.authToken, pref }),
      });
    } catch (e) {
      console.error('Diary Bot: pushPref failed', e);
    }
  }

  /** Push user profile summary to worker KV. */
  async pushProfile(userId: string, profile: string): Promise<void> {
    if (!this.authToken) return;
    try {
      await requestUrl({
        url: `${this.relayUrl}/profile`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ user_id: userId, token: this.authToken, profile }),
      });
    } catch (e) {
      console.error('Diary Bot: pushProfile failed', e);
    }
  }

  /** Returns and clears the last-pulled AI context from the worker. */
  consumeAiContext(): Array<{ role: 'user' | 'assistant'; content: string }> {
    const ctx = this.lastAiContext;
    this.lastAiContext = [];
    return ctx;
  }

  private async poll() {
    if (!this.isPolling || !this.userId || !this.authToken) return;

    try {
      const res = await requestUrl({
        url: `${this.relayUrl}/pull?user_id=${encodeURIComponent(this.userId)}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.authToken}` },
      });

      if (res.status === 200 && res.json.ok) {
        const rawMessages: any[] = res.json.messages || [];
        const aiContext: any[] = res.json.ai_context || [];

        // Store AI context — plugin consumes it when creating sessions
        if (aiContext.length > 0) {
          this.lastAiContext = aiContext;
        }

        // Deduplicate by message_id. Worker KV `delete` is eventually consistent,
        // so a poll right after another can return the same messages.
        const messages = rawMessages.filter((m) => {
          const id = m?.callback_query?.id ?? m?.message_id;
          if (id == null) return true; // can't dedup, pass through
          const numId = typeof id === 'string' ? parseInt(id, 10) || id.length : id;
          if (this.processedMessageIds.has(numId)) {
            console.log(`[DiaryBot] poll: skipping duplicate message_id=${id}`);
            return false;
          }
          this.processedMessageIds.add(numId);
          this.processedOrder.push(numId);
          if (this.processedOrder.length > 500) {
            const drop = this.processedOrder.shift();
            if (drop !== undefined) this.processedMessageIds.delete(drop);
          }
          return true;
        });

        if (rawMessages.length > 0) {
          console.log(`[DiaryBot] poll: ${rawMessages.length} received, ${messages.length} new`);
        }
        if (this.plugin) {
          this.plugin.status.lastPollAt = Date.now();
          this.plugin.status.lastPollCount = messages.length;
          this.plugin.status.lastPollError = null;
        }

        // Process events sequentially — handleMessage + handleCallbackQuery
        // mutate shared session state. Without await, msg N+1 (or save callback)
        // can run before msg N's handler finishes, racing the session.
        for (const msg of messages) {
          if (msg.callback_query) {
            for (const listener of this.callbackListeners) {
              try { await listener(msg.callback_query); } catch (e) { console.error('[DiaryBot] cq listener err', e); }
            }
          } else {
            for (const listener of this.messageListeners) {
              try { await listener(msg); } catch (e) { console.error('[DiaryBot] msg listener err', e); }
            }
          }
        }

        // Process finalize packets (cloud-side /done outputs).
        const finalize: FinalizePacket[] = res.json.finalize || [];
        for (const packet of finalize) {
          for (const listener of this.finalizeListeners) {
            try { await listener(packet); } catch (e) { console.error('[DiaryBot] finalize listener err', e); }
          }
        }
      } else if (this.plugin) {
        this.plugin.status.lastPollAt = Date.now();
        this.plugin.status.lastPollError = `pull HTTP ${res.status}`;
      }
    } catch (e: any) {
      if (this.plugin) {
        this.plugin.status.lastPollAt = Date.now();
        this.plugin.status.lastPollError = e?.message || 'network error';
      }
    }

    if (this.isPolling) {
      setTimeout(() => this.poll(), 3000);
    }
  }
}

/** Crypto-random base64url token (URL-safe, no padding). */
function generateBase64UrlToken(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  // base64url encode
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
