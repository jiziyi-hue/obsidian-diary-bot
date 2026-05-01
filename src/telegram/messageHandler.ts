import { TFile, normalizePath, requestUrl } from 'obsidian';
import DiaryBotPlugin from '../main';
import { diaryPath } from '../vault/noteWriter';
import { pad, fmtDate } from '../utils/dateUtils';
import { parse } from 'exifr';
import {
  SUMMARY_SYSTEM_PROMPT,
  WELCOME_MESSAGE,
  HELP_MESSAGE_TEMPLATE,
  ASK_SYSTEM_PROMPT,
  getReflectionPrompt,
} from '../ai/prompts';
import type { ReplyMode } from '../settings/settings';
import { parseStructuredSummary } from '../utils/summaryParser';
import { handleFinalizePacket } from './finalizeHandler';

export type ReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

const SILENT_REPLIES = ['📝 Recorded.', 'Got it.', 'Saved.', 'Logged.'];

export class MessageHandler {
  private plugin: DiaryBotPlugin;

  constructor(plugin: DiaryBotPlugin) {
    this.plugin = plugin;
  }

  /** Register relay message + callback handlers. Only path now — no more direct TG. */
  public registerRelayHandlers(): void {
    const relay = this.plugin.relayClient;

    relay.on('message', async (msg) => {
      if (!msg.text && !msg.photo) return;
      await this.handleMessage(msg);
    });

    relay.on('callback_query', async (cq) => {
      await this.handleCallbackQuery(cq);
    });

    relay.on('finalize', async (packet) => {
      try { await handleFinalizePacket(this.plugin, packet); }
      catch (e) { console.error('[DiaryBot] finalize handler err', e); }
    });
  }

  // ── Unified message handler ──
  private async handleMessage(msg: any): Promise<void> {
    const userId = msg.from?.id.toString();
    if (!userId) return;
    console.log(`[DiaryBot] handleMessage from=${userId} text=${(msg.text || msg.caption || '').slice(0, 80)}`);

    const allowed = this.plugin.settings.allowedUserId?.trim();
    if (!allowed) {
      // First message ever — auto-bind this user as the allowed one and persist.
      console.log(`[DiaryBot] auto-binding allowedUserId=${userId} (was empty)`);
      this.plugin.settings.allowedUserId = userId;
      await this.plugin.saveSettings();
    } else if (userId !== allowed) {
      console.log(`[DiaryBot] dropping message from ${userId} — not allowed (configured: ${allowed})`);
      return;
    }

    let text: string = msg.text || msg.caption || '';

    // Photo handling — fetch via worker /file proxy (worker holds the bot token).
    let photoLocation = '';
    if (msg.photo && msg.photo.length > 0) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      try {
        const buffer = await this.plugin.relayClient.downloadFile(userId, largestPhoto.file_id);
        if (buffer) {
          try {
            const exif = await parse(buffer, { gps: true });
            if (exif?.latitude && exif?.longitude) {
              photoLocation = (await reverseGeocode(exif.latitude, exif.longitude)) || '';
              // Persist to session for frontmatter emit at /done.
              const sess = this.plugin.sessionManager.getSession(userId);
              if (sess) {
                sess.activeLocation = `${exif.latitude},${exif.longitude}`;
                if (photoLocation) sess.activePlaceName = photoLocation;
              }
            }
          } catch { /* EXIF optional */ }

          const fileName = `IMG_${Date.now()}.jpg`;
          const attachmentsFolder = `${this.plugin.settings.diaryFolder}/Attachments`;
          await this.plugin.noteWriter.ensureFolderExists(attachmentsFolder);
          const fullPath = `${attachmentsFolder}/${fileName}`;
          const created = await this.plugin.app.vault.createBinary(fullPath, buffer);
          // Use Obsidian's internal link generator — produces correctly-resolving
          // wikilink (or markdown image) per user's vault settings, indexes file.
          // generateMarkdownLink returns plain link `[[file]]` — prepend `!` for embed.
          const sourcePath = diaryPath(this.plugin.settings.diaryFolder || 'Journal', fmtDate(new Date()));
          const linkText = this.plugin.app.fileManager.generateMarkdownLink(
            created as TFile,
            sourcePath
          );
          const markdownImage = linkText.startsWith('!') ? linkText : `!${linkText}`;
          text = text ? text + '\n' + markdownImage : markdownImage;
          if (photoLocation) text = text + `\n📍 ${photoLocation}`;
        } else {
          console.error('[DiaryBot] photo download via /file returned null');
        }
      } catch (e) {
        console.error('Diary Bot: photo download failed', e);
      }
    }

    // ── Commands ──
    if (text === '/start') {
      await this.sendReply(userId, WELCOME_MESSAGE);
      return;
    }
    if (text === '/help') {
      await this.sendReply(
        userId,
        HELP_MESSAGE_TEMPLATE(this.plugin.settings.replyMode)
      );
      return;
    }
    if (text === '/done' || text === '/save') {
      await this.finishSession(userId);
      return;
    }
    if (text === '/cancel') {
      this.plugin.sessionManager.clearSession(userId);
      await this.plugin.sessionManager.flush();
      await this.sendReply(userId, 'Cancelled, record not saved.');
      return;
    }
    if (text === '/onthisday') {
      await this.handleOnThisDay(userId);
      return;
    }
    if (text === '/stats') {
      await this.handleStats(userId);
      return;
    }
    if (text.startsWith('/ask')) {
      await this.handleAsk(userId, text.replace(/^\/ask\s*/, ''));
      return;
    }
    if (text === '/dashboard') {
      await this.sendReply(userId, '📊 Open Obsidian and click the 📊 ribbon icon (or run "Diary Dashboard" command) to see your dashboard.');
      return;
    }
    if (msg.location) {
      await this.handleLocation(msg, userId);
      return;
    }
    // /chat /silent /mode /persona /done /cancel /prompt /search are handled
    // entirely by the worker (returns before queueing). They never reach plugin.

    // ── Session handling ──
    // Use plugin processing time (now), not msg.date. Worker AI reply + queue + plugin
    // pull each add latency, so msg.date is stale by 10-30s and can be older than the
    // existing session.startedAt, breaking isExpired logic.
    const msgTime = new Date();

    let session = this.plugin.sessionManager.getSession(userId);
    if (!session) {
      session = this.plugin.sessionManager.createSession(userId, msgTime);
    }

    if (
      session.messages.length > 0 &&
      this.plugin.sessionManager.isSessionExpiredAt(session, msgTime, this.plugin.settings.sessionTimeoutMinutes)
    ) {
      await this.sendReply(userId, 'Starting a new record (previous session timed out).');
      await this.finishSession(userId, true);
      session = this.plugin.sessionManager.createSession(userId, msgTime);
    }

    // ── Worker is canonical AI replier. Worker stores running [user,assistant,...] ctx.
    //    On each worker_replied msg, REPLACE session.messages from latest ctx — that's
    //    the source of truth. Pushing user msg again here would duplicate it in vault.
    if (msg.worker_replied) {
      const originalText = msg.text || msg.caption || '';
      const aiCtx = this.plugin.relayClient.consumeAiContext();
      if (aiCtx.length > 0) {
        session.messages = [...aiCtx];
        // Worker's ctx only stores text/caption — plugin may have augmented `text`
        // with image wikilinks / location. Find the matching user msg in ctx (by
        // content equality with originalText) and replace with augmented text.
        // Match latest occurrence first (handles repeated same-text msgs).
        if (text && text !== originalText) {
          for (let i = session.messages.length - 1; i >= 0; i--) {
            const m = session.messages[i];
            if (m.role === 'user' && m.content === originalText) {
              session.messages[i] = { role: 'user', content: text };
              break;
            }
          }
        }
        session.state = 'REFLECTING';
      } else if (text) {
        // Worker replied but ctx absent (silent mode / AI silent fail).
        // Record user msg so /done has content.
        session.messages.push({ role: 'user', content: text });
      }
      session.lastActivityAt = msgTime;
      await this.plugin.sessionManager.flush();
      console.log(`[DiaryBot] msg ${msg.message_id}: worker_replied, session has ${session.messages.length} msgs`);
      return;
    }

    // Non-worker_replied path (silent mode, /commands fall-through, or worker AI failed).
    // Plugin owns the conversation here — push user msg + run own AI reflection below.
    const isFirstUserMessage = session.messages.length === 0;
    session.messages.push({ role: 'user', content: text });
    session.lastActivityAt = msgTime;
    await this.plugin.sessionManager.flush();

    // ── Silent mode ──
    if (this.plugin.settings.replyMode === 'silent') {
      const idx = (session.silentReplyIndex ?? 0) % SILENT_REPLIES.length;
      session.silentReplyIndex = idx + 1;
      await this.plugin.sessionManager.flush();
      await this.sendReply(userId, SILENT_REPLIES[idx] + '\n\n_(send /save to save)_', { parse_mode: 'Markdown' });
      return;
    }

    // ── Conversation mode ──
    if (isFirstUserMessage) {
      try {
        const { entities, tags } = await this.plugin.memoryRetriever.extractTagsAndEntities(text);
        session.activeEntities = entities;
        session.activeTags = tags;
        await this.plugin.sessionManager.flush();
      } catch (e) {
        console.error('Diary Bot: tag/entity extraction failed', e);
      }
    }

    if (session.followUpCount >= this.plugin.settings.maxFollowUpQuestions) {
      await this.sendReply(userId, 'I have plenty to work with — let me put this together for you...');
      await this.finishSession(userId);
      return;
    }

    await this.sendChatAction(userId, 'typing');
    try {
      const isFirstTurn = session.followUpCount === 0;
      const memoryBlock = await this.buildMemoryBlock(session.activeEntities, session.activeTags, isFirstTurn);
      const systemPrompt = getReflectionPrompt('', memoryBlock);

      const reply = await this.plugin.aiRouter.chat(systemPrompt, session.messages);
      session.messages.push({ role: 'assistant', content: reply });
      session.followUpCount++;
      session.state = 'REFLECTING';
      await this.plugin.sessionManager.flush();

      await this.sendReply(userId, reply, {
        parse_mode: 'Markdown',
        reply_markup: replyKeyboard(),
      });
    } catch (e) {
      console.error('AI Error:', e);
      await this.sendReply(userId, 'AI temporarily unavailable. Your message is saved — try /done later.');
    }
  }

  private async buildMemoryBlock(entities?: string[], tags?: string[], isFirstTurn: boolean = true): Promise<string> {
    const s = this.plugin.settings;
    const memoryRetriever = this.plugin.memoryRetriever;
    memoryRetriever.vaultWideSearch = s.enableVaultWideSearch;
    if (!s.enableMemory && !s.enableTagRag && !s.enableEntityLinks) return '';

    if (!isFirstTurn) {
      const parts: string[] = [];
      if (entities && entities.length) parts.push(`Previously mentioned: ${entities.join(', ')}.`);
      if (tags && tags.length) parts.push(`Topics: ${tags.join(', ')}.`);
      return parts.length ? `(from earlier this session — ${parts.join(' ')})` : '';
    }

    const recency = s.enableMemory ? await memoryRetriever.getRecencyMemory(s.memoryDays) : '';
    const entityLinked =
      s.enableEntityLinks && entities && entities.length
        ? await memoryRetriever.getEntityLinkedMemory(entities, 3, s.memoryDays)
        : '';
    const tagMatched =
      s.enableTagRag && tags && tags.length
        ? await memoryRetriever.getTagMatchedMemory(tags, 3, s.memoryDays)
        : '';
    return memoryRetriever.composeMemoryBlock({ recency, entityLinked, tagMatched });
  }

  // ── Callback handler ──
  private async handleCallbackQuery(cq: any): Promise<void> {
    const userId = cq.from?.id?.toString();
    const data: string = cq.data || '';
    if (!userId) return;
    if (userId !== this.plugin.settings.allowedUserId?.trim()) {
      await this.plugin.relayClient.answerCallbackQuery(cq.id, 'Not authorised.');
      return;
    }

    if (data === 'save') {
      await this.plugin.relayClient.answerCallbackQuery(cq.id, 'Saving…');
      await this.finishSession(userId);
      return;
    }
    if (data === 'help') {
      await this.plugin.relayClient.answerCallbackQuery(cq.id);
      await this.sendReply(
        userId,
        HELP_MESSAGE_TEMPLATE(this.plugin.settings.replyMode)
      );
      return;
    }
    if (data.startsWith('mode:')) {
      const value = data.slice('mode:'.length) as ReplyMode;
      if (value === 'silent' || value === 'conversation') {
        this.plugin.settings.replyMode = value;
        await this.plugin.saveSettings();
        if (this.plugin.settings.relayUserId) {
          await this.plugin.relayClient.pushPref(this.plugin.settings.relayUserId, { replyMode: value });
        }
        await this.plugin.relayClient.answerCallbackQuery(cq.id, `Mode: ${value}`);
        const label = value === 'silent' ? '🤫 Silent — record-only, no AI replies' : '💬 Conversation — AI reflection enabled';
        await this.sendReply(userId, label);
      } else {
        await this.plugin.relayClient.answerCallbackQuery(cq.id, 'Unknown mode.');
      }
      return;
    }

    await this.plugin.relayClient.answerCallbackQuery(cq.id);
  }

  // ── Finish & save session ──
  public async finishSession(userId: string, isAutoSave: boolean = false): Promise<void> {
    const session = this.plugin.sessionManager.getSession(userId);
    if (!session || session.messages.length === 0) {
      if (!isAutoSave) await this.sendReply(userId, 'No conversation record found.');
      return;
    }

    session.state = 'SAVING';
    if (!isAutoSave) await this.sendReply(userId, 'Organising…');
    await this.sendChatAction(userId, 'typing');

    try {
      const memoryBlock = await this.buildMemoryBlock(session.activeEntities, session.activeTags);
      const summarySystem = memoryBlock
        ? `${SUMMARY_SYSTEM_PROMPT}\n\n## Memory (for reference only — do not echo)\n\n${memoryBlock}`
        : SUMMARY_SYSTEM_PROMPT;

      const raw = await this.plugin.aiRouter.summarize(summarySystem, session.messages);
      const { frontmatter, body } = parseStructuredSummary(raw);

      // Collect entities; build promise list to run in parallel.
      const allEntities: string[] = [];
      const ensurePromises: Promise<unknown>[] = [];
      const collect = (names: string[] | undefined, type: 'person' | 'place' | 'project') => {
        if (!Array.isArray(names)) return;
        for (const raw of names) {
          const name = String(raw).trim();
          if (!name) continue;
          allEntities.push(name);
          if (this.plugin.settings.enableEntityLinks) {
            ensurePromises.push(this.plugin.entityNotes.ensureEntityNote(name, type));
          }
        }
      };
      collect(frontmatter.people, 'person');
      collect(frontmatter.places, 'place');
      collect(frontmatter.projects, 'project');
      // Wait for all entity stub creations + alias merges in parallel.
      await Promise.all(ensurePromises);

      const now = new Date();
      const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

      // Match both wikilink (![[...IMG_...]]) and markdown (![alt](...IMG_...)) forms
      const photos = session.messages
        .map((m) => m.content.match(/!\[\[[^\]]*IMG_[^\]]+\]\]|!\[[^\]]*\]\([^)]*IMG_[^)]+\)/g))
        .flat()
        .filter(Boolean) as string[];
      const uniquePhotos = [...new Set(photos)];

      const moodEmoji = moodToEmoji(frontmatter.mood);
      const energyNum = frontmatter.energy || 5;
      const moodLabel = frontmatter.mood || 'journal';

      // Adaptive photo gallery layout (count-based, Day One inspired).
      const photoStr = renderPhotoGallery(uniquePhotos);

      const narrativeBody = body
        .replace(/^> \*[^\n]+\*?\n*/m, '')
        .replace(/#\S+/g, '')
        .trim();

      // Inline entity wikilinks + topic hashtags (footer of entry).
      const peopleLinks = (frontmatter.people || []).map((n: string) => `[[${n}]]`);
      const placeLinks = (frontmatter.places || []).map((n: string) => `[[${n}]]`);
      const projectLinks = (frontmatter.projects || []).map((n: string) => `[[${n}]]`);
      const topicTags = (frontmatter.topics || []).map((t: string) => `#${t}`);
      const metaInline = [...peopleLinks, ...placeLinks, ...projectLinks, ...topicTags].join(' ');

      const transcriptLines = session.messages
        .map((m) => {
          const clean = m.content
            .replace(/!\[\[.*?\]\]/g, '')
            .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
            .trim();
          const speaker = m.role === 'user' ? 'Me' : 'AI';
          return clean ? `**${speaker}**: ${clean}` : '';
        })
        .filter(Boolean);
      const transcript = transcriptLines.length > 0
        ? `\n\n> [!quote]- 💬 Chat\n> ` + transcriptLines.join('\n> ')
        : '';

      // Day One inspired layout:
      //   [photo hero]
      //   ## 14:30 · 😊 happy · ⚡ 7/10
      //   narrative paragraph(s)
      //   #tags [[entities]]
      //   > collapsed chat log
      const wrappedBody =
        (photoStr ? `${photoStr}\n\n` : '') +
        `## ${stamp} · ${moodEmoji} ${moodLabel} · ⚡ ${energyNum}/10\n\n` +
        `${narrativeBody}` +
        (metaInline ? `\n\n${metaInline}` : '') +
        transcript +
        `\n`;

      // Day One compatible slim frontmatter — only what's queryable + Day One
      // schema fields. topics live as inline #hashtags in body. description
      // folded into narrative.
      const fmForNote: Record<string, any> = {
        mood: frontmatter.mood,
        energy: frontmatter.energy,
        starred: false,
        pinned: false,
      };
      // Map location (esm7/obsidian-map-view native format: "lat,lng" string).
      if (session.activeLocation) {
        fmForNote.location = session.activeLocation;
        if (session.activePlaceName) fmForNote.locationName = session.activePlaceName;
      }

      await this.plugin.noteWriter.appendStructured({
        frontmatter: fmForNote,
        body: wrappedBody,
        entities: allEntities,
      });

      const tagsLine = Array.isArray(frontmatter.topics) && frontmatter.topics.length
        ? `\nTags: ${frontmatter.topics.map((t: string) => `#${t}`).join(' ')}`
        : '';
      if (isAutoSave) {
        await this.sendReply(userId, '✓ Auto-saved to today\'s diary.' + tagsLine);
      } else {
        await this.sendReply(userId, '✓ Saved to today\'s diary.' + tagsLine + '\n\nSend any message to start a new entry.');
      }

      this.plugin.sessionManager.clearSession(userId);
      await this.plugin.sessionManager.flush();
      // Tell worker to clear its ctx + queue so next session starts fresh.
      await this.plugin.relayClient.finishSession(userId);

      // M3.4: push entities to worker D1 for people graph + smart reminders.
      this.plugin.relayClient.indexEntry(userId, {
        date: fmtDate(new Date()),
        path: this.plugin.noteWriter.getDailyNotePath(),
        mood: frontmatter.mood,
        people: frontmatter.people || [],
        places: frontmatter.places || [],
        projects: frontmatter.projects || [],
      }).catch((e) => console.error('[DiaryBot] indexEntry failed', e));
    } catch (e) {
      console.error('Error saving session:', e);
      await this.sendReply(userId, 'Failed to save record. Please check plugin settings.');
      session.state = 'REFLECTING';
    }
  }

  // ── /ask ──
  private async handleAsk(userId: string, question: string): Promise<void> {
    if (!question.trim()) {
      await this.sendReply(userId, '📊 **/ask — Ask anything about your diary**\n\nUsage: `/ask <question>`\n\nExamples:\n`/ask 我什么时候最焦虑？`\n`/ask 这周和谁交流最多？`\n`/ask which month was most productive?`\n`/ask 我的情绪规律是什么？`', { parse_mode: 'Markdown' });
      return;
    }
    await this.sendReply(userId, 'Searching your diary…');
    await this.sendChatAction(userId, 'typing');
    try {
      const folder = normalizePath(this.plugin.settings.diaryFolder || 'Journal');
      const parts: string[] = [];

      // Parallel read of weekly + monthly. Slice to 400 chars each (was 600).
      // Skip body read if frontmatter description present (cheap path).
      const weeklyFolder = normalizePath(folder + '/Weekly');
      const monthlyFolder = normalizePath(folder + '/Monthly');
      const reportFiles = this.plugin.app.vault.getFiles().filter((f) =>
        f.extension === 'md' && (f.path.startsWith(weeklyFolder + '/') || f.path.startsWith(monthlyFolder + '/'))
      );
      const reportSnippets = await Promise.all(
        reportFiles.map(async (f) => {
          const cache = this.plugin.app.metadataCache.getFileCache(f);
          const desc = (cache?.frontmatter as any)?.description;
          if (typeof desc === 'string' && desc.trim()) {
            const tag = f.path.startsWith(weeklyFolder + '/') ? 'Weekly' : 'Monthly';
            return `[${tag}] ${f.basename}\n${desc.trim()}`;
          }
          const text = await this.plugin.app.vault.cachedRead(f);
          const tag = f.path.startsWith(weeklyFolder + '/') ? 'Weekly' : 'Monthly';
          return `[${tag}] ${f.basename}\n${text.slice(0, 400)}`;
        })
      );
      parts.push(...reportSnippets);

      // Daily entries: frontmatter-only (no body read = much faster on iCloud).
      const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const now = new Date();
      const matched: string[] = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const path = diaryPath(folder, dateStr);
        const af = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(af instanceof TFile)) continue;
        const cache = this.plugin.app.metadataCache.getFileCache(af);
        const fm = (cache?.frontmatter || {}) as any;
        const topics = Array.isArray(fm.topics) ? fm.topics.join(' ').toLowerCase() : '';
        const desc = typeof fm.description === 'string' ? fm.description : '';
        const hits = keywords.length === 0 || keywords.some(k => topics.includes(k));
        if (hits && desc) {
          const mood = fm.mood || '';
          const energy = fm.energy !== undefined ? fm.energy : '';
          matched.push(`${dateStr} | mood:${mood} | energy:${energy} | topics:${topics} | ${desc}`);
        }
      }
      if (matched.length > 0) {
        parts.push(`[Recent matching entries]\n${matched.join('\n')}`);
      }

      if (parts.length === 0) {
        await this.sendReply(userId, 'No diary data yet. Start writing!');
        return;
      }

      const dataBlock = parts.join('\n\n');
      const answer = await this.plugin.aiRouter.chat(ASK_SYSTEM_PROMPT, [
        { role: 'user', content: `Diary data:\n${dataBlock}\n\nQuestion: ${question}` }
      ]);
      await this.sendReply(userId, answer, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Ask failed:', e);
      await this.sendReply(userId, 'Sorry, failed to search your diary.');
    }
  }

  // ── On This Day ──
  private async handleOnThisDay(userId: string): Promise<void> {
    await this.sendReply(userId, '🔍 Looking back through your diaries…');
    await this.sendChatAction(userId, 'typing');
    try {
      const { vault } = this.plugin.app;
      const folder = normalizePath(this.plugin.settings.diaryFolder || 'Journal');
      const today = new Date();
      const month = pad(today.getMonth() + 1);
      const day = pad(today.getDate());
      const summaries: Array<{ year: number; snippet: string }> = [];

      const allFiles = vault.getFiles();
      for (const f of allFiles) {
        if (!f.path.startsWith(folder + '/')) continue;
        if (f.extension !== 'md') continue;
        const parts = f.basename.split('-');
        if (parts.length !== 3) continue;
        if (parts[1] !== month || parts[2] !== day) continue;
        const year = parseInt(parts[0], 10);
        if (year === today.getFullYear()) continue;
        const cache = this.plugin.app.metadataCache.getFileCache(f);
        const desc = (cache?.frontmatter as any)?.description;
        const snippet = desc || (await vault.cachedRead(f)).slice(0, 200);
        summaries.push({ year, snippet: snippet.trim() });
      }

      if (summaries.length === 0) {
        await this.sendReply(userId, '📭 No entries found from this day in past years. Keep writing!');
        return;
      }

      summaries.sort((a, b) => b.year - a.year);
      const lines = summaries.map(s =>
        `**${s.year}** — ${s.snippet.length > 150 ? s.snippet.slice(0, 150) + '…' : s.snippet}`
      );
      await this.sendReply(userId, `📅 **On This Day — ${today.getFullYear()}**\n\n${lines.join('\n\n')}`);
    } catch (e) {
      console.error('On This Day failed:', e);
      await this.sendReply(userId, 'Sorry, failed to look up past entries.');
    }
  }

  // ── Stats ──
  private async handleStats(userId: string): Promise<void> {
    await this.sendChatAction(userId, 'typing');
    try {
      const { vault } = this.plugin.app;
      const folder = normalizePath(this.plugin.settings.diaryFolder || 'Journal');
      let totalEntries = 0;
      let totalWords = 0;
      let moodSum = 0;
      let moodCount = 0;
      let energySum = 0;
      let energyCount = 0;
      let streak = 0;
      const d = new Date();

      for (let i = 0; i < 365; i++) {
        const check = new Date(d);
        check.setDate(check.getDate() - i);
        const path = diaryPath(folder, fmtDate(check));
        const file = vault.getAbstractFileByPath(path);
        if (file) streak++;
        else break;
      }

      const moodMap: Record<string, number> = {};
      const allFiles = vault.getFiles();
      for (const f of allFiles) {
        if (!f.path.startsWith(folder + '/')) continue;
        if (f.extension !== 'md') continue;
        if (f.basename.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const text = await vault.cachedRead(f);
          const entryCount = text.split('> [!diary]').length - 1;
          totalEntries += Math.max(1, entryCount);
          totalWords += text.split(/\s+/).length;

          const cache = this.plugin.app.metadataCache.getFileCache(f);
          const fm = cache?.frontmatter as any;
          const mood = fm?.mood;
          if (typeof mood === 'string' && mood) {
            moodMap[mood] = (moodMap[mood] || 0) + 1;
            const ms = moodScore(mood);
            if (ms > 0) { moodSum += ms; moodCount++; }
          }
          const energy = fm?.energy;
          if (typeof energy === 'number' && energy >= 1 && energy <= 10) {
            energySum += energy;
            energyCount++;
          }
        }
      }

      const avgMood = moodCount > 0 ? (moodSum / moodCount).toFixed(1) : '—';
      const avgEnergy = energyCount > 0 ? (energySum / energyCount).toFixed(1) : '—';
      const topMoods = Object.entries(moodMap).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([m, c]) => `${moodToEmoji(m)} ${m} (${c})`).join('  ');

      const msg = [
        `📊 **Your Diary Stats**`,
        ``,
        `📝 Entries: **${totalEntries}**`,
        `🔥 Current streak: **${streak}** days`,
        `📄 Total words: **${totalWords.toLocaleString()}**`,
        `😌 Avg mood: **${avgMood}**`,
        `⚡ Avg energy: **${avgEnergy}/10**`,
        topMoods ? `\nTop moods: ${topMoods}` : '',
      ].join('\n');

      await this.sendReply(userId, msg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Stats failed:', e);
      await this.sendReply(userId, 'Sorry, failed to compute stats.');
    }
  }

  // ── Location handler ──
  private async handleLocation(msg: any, userId: string): Promise<void> {
    const lat = msg.location?.latitude;
    const lng = msg.location?.longitude;
    if (!lat || !lng) return;

    let placeName = '';
    let weather = '';
    try {
      placeName = (await reverseGeocode(lat, lng)) || '';
    } catch { /* geocode optional */ }

    try {
      const res = await requestUrl({
        url: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`,
        method: 'GET',
      });
      if (res?.json?.current_weather) {
        const w = res.json.current_weather;
        weather = `${weatherCodeEmoji(w.weathercode)} ${w.temperature}°C`;
      }
    } catch { /* weather optional */ }

    const placeText = placeName || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const locationLine = weather
      ? `📍 ${placeText} — ${weather}`
      : `📍 ${placeText}`;

    const session = this.plugin.sessionManager.getSession(userId);
    if (session) {
      session.messages.push({ role: 'user', content: locationLine });
      if (placeName) {
        session.activeEntities = [...(session.activeEntities || []), placeName];
      }
      session.activeLocation = `${lat},${lng}`;
      session.activePlaceName = placeName || undefined;
      session.lastActivityAt = new Date();
      await this.plugin.sessionManager.flush();
    }

    await this.sendReply(userId, `📍 ${placeName || placeText}${weather ? ' · ' + weather : ''}\n\nLocation saved. Will appear in your diary entry.`);
  }

  // ── Reply helpers — route through relay client ──
  private async sendReply(
    userId: string,
    text: string,
    options?: { parse_mode?: string; reply_markup?: ReplyMarkup }
  ): Promise<void> {
    await this.plugin.relayClient.sendMessage(userId, text, options);
  }

  private async sendChatAction(userId: string, action: string): Promise<void> {
    await this.plugin.relayClient.sendChatAction(userId, action);
  }
}

// ── Photo gallery — plain markdown wikilinks with size hints by count ──
// Obsidian doesn't render wikilinks inside <div> (raw HTML bypasses markdown
// parser). So flow them as space-separated wikilinks; the bigger the count,
// the smaller the size hint, simulating a gallery.
function renderPhotoGallery(photos: string[]): string {
  if (photos.length === 0) return '';
  if (photos.length === 1) return photos[0];
  // Inject |size into wikilink. generateMarkdownLink returns ![[path]] or
  // ![[path|alias]] — append our size as additional pipe segment.
  const size = photos.length === 2 ? 400 : photos.length === 3 ? 300 : 220;
  const sized = photos.map((p) => withSize(p, size));
  return sized.join(' ');
}

function withSize(embed: string, size: number): string {
  // ![[path]]      → ![[path|size]]
  // ![[path|alt]]  → ![[path|alt|size]]
  // ![alt](path)   → ![alt|size](path)
  if (embed.startsWith('![[')) {
    return embed.replace(/]]$/, `|${size}]]`);
  }
  return embed.replace(/^!\[([^\]]*)\]/, (_m, alt) => `![${alt}|${size}]`);
}

// ── Inline keyboards ──
function replyKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✓ Save', callback_data: 'save' },
        { text: '❓ Help', callback_data: 'help' },
      ],
    ],
  };
}

function modeKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: '💬 Chat', callback_data: 'mode:conversation' },
        { text: '🤫 Silent', callback_data: 'mode:silent' },
      ],
    ],
  };
}

function moodToEmoji(mood?: string): string {
  const m = (mood || '').toLowerCase();
  if (m.includes('anxious') || m.includes('worried')) return '😰';
  if (m.includes('sad') || m.includes('down')) return '😢';
  if (m.includes('angry') || m.includes('frustrated')) return '😤';
  if (m.includes('happy') || m.includes('joyful')) return '😊';
  if (m.includes('excited') || m.includes('energetic')) return '🎉';
  if (m.includes('calm') || m.includes('peaceful')) return '😌';
  if (m.includes('tired') || m.includes('exhausted')) return '😴';
  if (m.includes('hopeful') || m.includes('optimistic')) return '🌱';
  if (m.includes('grateful') || m.includes('thankful')) return '🙏';
  if (m.includes('contemplative') || m.includes('reflective')) return '🤔';
  return '💭';
}

function extractPoeticLine(body: string): string {
  const match = body.match(/^> \*([^\n]+)\*?/m);
  return match ? match[1].trim() : '';
}

function moodScore(mood: string): number {
  const s = mood.toLowerCase();
  if (s.includes('happy') || s.includes('excited') || s.includes('grateful') || s.includes('joyful')) return 8;
  if (s.includes('hopeful') || s.includes('calm') || s.includes('peaceful') || s.includes('optimistic')) return 7;
  if (s.includes('contemplative') || s.includes('reflective')) return 6;
  if (s.includes('tired') || s.includes('anxious') || s.includes('worried')) return 4;
  if (s.includes('sad') || s.includes('frustrated') || s.includes('angry') || s.includes('down')) return 3;
  return 5;
}

// ── Telegram file helpers (for photo download) ──
async function getTelegramFileUrl(token: string, fileId: string): Promise<string | null> {
  try {
    const res = await requestUrl({
      url: `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
      method: 'GET',
    });
    if (res.status === 200 && res.json.ok) {
      return `https://api.telegram.org/file/bot${token}/${res.json.result.file_path}`;
    }
  } catch (e) {
    console.error('Failed to get file path', e);
  }
  return null;
}

async function downloadTelegramFile(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await requestUrl({ url, method: 'GET' });
    if (res.status === 200) return res.arrayBuffer;
  } catch (e) {
    console.error('Failed to download file', e);
  }
  return null;
}

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const lang = (typeof navigator !== 'undefined' && navigator.language)
    ? navigator.language.split('-')[0]
    : 'en';
  try {
    const res = await requestUrl({
      url: `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&accept-language=${encodeURIComponent(lang)}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Obsidian-AI-Diary-Bot/1.0 (+https://github.com/jiziyi-hue)',
        'Accept': 'application/json',
      },
    });
    const geo = res?.json;
    if (geo?.name) {
      const addr = geo.address || {};
      return [geo.name, addr.city || addr.town || addr.county || '', addr.country || '']
        .filter(Boolean).join(', ');
    }
  } catch { /* fall through */ }
  return null;
}

function weatherCodeEmoji(code: number): string {
  if (code <= 1) return '☀️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌧️';
  if (code <= 67) return '🌨️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌧️';
  if (code <= 86) return '🌨️';
  if (code <= 99) return '⛈️';
  return '🌤️';
}
