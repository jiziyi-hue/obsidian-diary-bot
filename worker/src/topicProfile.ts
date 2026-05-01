import type { Env } from './index';
import { TOPIC_BY_KEY } from './topics';

/**
 * Topic profile state machine — Memobase-inspired threshold flushing.
 *
 * Flush triggers (whichever first):
 *   - mention_count delta >= 5 since last_flushed
 *   - last_updated > 24h ago AND pending_buffer non-empty
 *
 * Update semantics: ADD-only (Mem0 pattern). LLM is asked to AUGMENT existing
 * profile with new observations, never erase. User can manually edit via
 * Topics/<key>.md and reverse-sync.
 */

const FLUSH_THRESHOLD = 5; // mentions since last flush
const FLUSH_IDLE_HOURS = 24;

const PROFILE_DERIVE_PROMPT = `
You are maintaining an evolving "user profile" for a single life-area topic, based on a stream of recent diary entry summaries.

EXISTING PROFILE (may be empty for first build):
{{existing_profile}}

EXISTING THEMES (recurring patterns observed previously):
{{existing_themes}}

NEW ENTRIES TO INCORPORATE:
{{new_entries}}

Rules:
- ADD only. Augment existing profile with new observations; never erase prior facts unless they are explicitly contradicted by multiple new entries.
- Profile = 3-6 sentences describing WHO the user is in this topic context: their patterns, values, struggles, recurring contradictions. Specific over generic.
- Themes = 3-7 short bullet phrases capturing recurring patterns ("Monday-energy / Thursday-drain", "tends to over-commit then withdraw").
- Reply in user's language (auto-detect from entries).
- DO NOT include events, dates, or names. Profile is about TYPE of person, not log of events.

Output EXACTLY this JSON, no prose, no code fences:
{"profile": "<3-6 sentences>", "themes": ["<phrase>", "<phrase>", ...]}
`.trim();

export interface TopicProfile {
  user_profile: string;
  themes: string[];
  mention_count: number;
  last_updated: string | null;
  last_flushed: string | null;
  pending_buffer: string;
}

/** Read profile (creates empty row if missing). */
export async function getProfile(userId: string, topic: string, env: Env): Promise<TopicProfile> {
  const empty: TopicProfile = { user_profile: '', themes: [], mention_count: 0, last_updated: null, last_flushed: null, pending_buffer: '' };
  if (!env.DB) return empty;
  try {
    const row = await env.DB
      .prepare('SELECT user_profile, themes_json, mention_count, last_updated, last_flushed, pending_buffer FROM topic_profiles WHERE user_id = ? AND topic = ?')
      .bind(userId, topic)
      .first<{ user_profile: string; themes_json: string; mention_count: number; last_updated: string; last_flushed: string; pending_buffer: string }>();
    if (!row) return empty;
    return {
      user_profile: row.user_profile || '',
      themes: safeJson(row.themes_json, []),
      mention_count: row.mention_count || 0,
      last_updated: row.last_updated,
      last_flushed: row.last_flushed,
      pending_buffer: row.pending_buffer || '',
    };
  } catch (e: any) {
    console.error('[getProfile] failed', e?.message || e);
    return empty;
  }
}

/** Append entry summary to pending buffer + bump mention count. Cheap, sync. */
export async function appendToBuffer(
  userId: string,
  topic: string,
  entrySummary: string,
  env: Env
): Promise<{ shouldFlush: boolean; profile: TopicProfile }> {
  const empty: TopicProfile = { user_profile: '', themes: [], mention_count: 0, last_updated: null, last_flushed: null, pending_buffer: '' };
  if (!env.DB || !TOPIC_BY_KEY[topic]) return { shouldFlush: false, profile: empty };
  if (topic === 'random') return { shouldFlush: false, profile: empty }; // no profile for random topic

  const now = new Date().toISOString();
  const date = now.slice(0, 10);

  try {
    // Upsert: insert if missing, else append buffer + increment count.
    const existing = await getProfile(userId, topic, env);
    const newBuffer = existing.pending_buffer
      ? existing.pending_buffer + '\n---\n' + `[${date}] ` + entrySummary.slice(0, 800)
      : `[${date}] ` + entrySummary.slice(0, 800);
    const newCount = existing.mention_count + 1;

    if (existing.last_updated === null) {
      await env.DB
        .prepare(
          `INSERT INTO topic_profiles (user_id, topic, user_profile, themes_json, mention_count, last_updated, pending_buffer)
           VALUES (?, ?, ?, '[]', ?, ?, ?)`
        )
        .bind(userId, topic, '', newCount, now, newBuffer)
        .run();
    } else {
      await env.DB
        .prepare(
          `UPDATE topic_profiles SET pending_buffer = ?, mention_count = ?, last_updated = ? WHERE user_id = ? AND topic = ?`
        )
        .bind(newBuffer, newCount, now, userId, topic)
        .run();
    }

    const lastFlushedDate = existing.last_flushed ? new Date(existing.last_flushed).getTime() : 0;
    const sinceFlush = (Date.now() - lastFlushedDate) / 36e5; // hours
    const sinceFlushCount = existing.last_flushed ? newCount - (existing as any).mention_at_last_flush || 0 : newCount;
    const shouldFlush =
      newCount === 1 ||                             // first ever
      newCount % FLUSH_THRESHOLD === 0 ||          // every 5 mentions
      (sinceFlush > FLUSH_IDLE_HOURS && existing.pending_buffer.length > 0);

    return {
      shouldFlush,
      profile: { ...existing, mention_count: newCount, pending_buffer: newBuffer, last_updated: now },
    };
  } catch (e: any) {
    console.error('[appendToBuffer] failed', e?.message || e);
    return { shouldFlush: false, profile: empty };
  }
}

/** Flush buffer → call DeepSeek → write profile + themes back. */
export async function flushProfile(
  userId: string,
  topic: string,
  env: Env
): Promise<boolean> {
  if (!env.DB || !env.DEEPSEEK_API_KEY) return false;
  try {
    const cur = await getProfile(userId, topic, env);
    if (!cur.pending_buffer.trim()) return false;

    const prompt = PROFILE_DERIVE_PROMPT
      .replace('{{existing_profile}}', cur.user_profile || '(no prior profile yet)')
      .replace('{{existing_themes}}', cur.themes.length ? cur.themes.map((t) => `- ${t}`).join('\n') : '(none)')
      .replace('{{new_entries}}', cur.pending_buffer);

    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error('[flushProfile] non-ok', res.status, await res.text());
      return false;
    }
    const j: any = await res.json();
    const raw = j?.choices?.[0]?.message?.content || '';
    let parsed: { profile?: string; themes?: string[] } = {};
    try { parsed = JSON.parse(raw); } catch { /* malformed, abort flush */ return false; }
    if (!parsed.profile) return false;

    const now = new Date().toISOString();
    await env.DB
      .prepare(
        `UPDATE topic_profiles SET user_profile = ?, themes_json = ?, pending_buffer = '', last_flushed = ?, last_updated = ? WHERE user_id = ? AND topic = ?`
      )
      .bind(parsed.profile, JSON.stringify(parsed.themes || []), now, now, userId, topic)
      .run();
    console.log(`[flushProfile] ${userId}/${topic} regenerated`);
    return true;
  } catch (e: any) {
    console.error('[flushProfile] failed', e?.message || e);
    return false;
  }
}

/** Direct overwrite (used by reverse-sync from plugin's edited Topics/<topic>.md). */
export async function setProfileFromUser(
  userId: string,
  topic: string,
  profile: string,
  themes: string[],
  env: Env
): Promise<boolean> {
  if (!env.DB) return false;
  try {
    const now = new Date().toISOString();
    const existing = await getProfile(userId, topic, env);
    if (existing.last_updated === null) {
      await env.DB
        .prepare(
          `INSERT INTO topic_profiles (user_id, topic, user_profile, themes_json, mention_count, last_updated, last_flushed)
           VALUES (?, ?, ?, ?, 0, ?, ?)`
        )
        .bind(userId, topic, profile, JSON.stringify(themes), now, now)
        .run();
    } else {
      await env.DB
        .prepare(`UPDATE topic_profiles SET user_profile = ?, themes_json = ?, last_updated = ?, last_flushed = ? WHERE user_id = ? AND topic = ?`)
        .bind(profile, JSON.stringify(themes), now, now, userId, topic)
        .run();
    }
    return true;
  } catch (e: any) {
    console.error('[setProfileFromUser] failed', e?.message || e);
    return false;
  }
}

/** All profiles for a user (plugin syncs to Topics/ folder on load). */
export async function listProfiles(userId: string, env: Env): Promise<Array<{ topic: string } & TopicProfile>> {
  if (!env.DB) return [];
  try {
    const rows = await env.DB
      .prepare('SELECT topic, user_profile, themes_json, mention_count, last_updated, last_flushed FROM topic_profiles WHERE user_id = ?')
      .bind(userId)
      .all();
    return ((rows.results as any) || []).map((r: any) => ({
      topic: r.topic,
      user_profile: r.user_profile || '',
      themes: safeJson(r.themes_json, []),
      mention_count: r.mention_count || 0,
      last_updated: r.last_updated,
      last_flushed: r.last_flushed,
      pending_buffer: '',
    }));
  } catch (e: any) {
    console.error('[listProfiles] failed', e?.message || e);
    return [];
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s); } catch { return fallback; }
}
