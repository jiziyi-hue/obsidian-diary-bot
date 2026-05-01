import type { Env } from './index';

const SUMMARY_SYSTEM_PROMPT = `
You are a diary synthesis assistant. Read the conversation between the user (first person) and a journal companion. Produce a structured Obsidian-ready entry.

Output EXACTLY this format (keep the literal marker lines, including dashes):

---FRONTMATTER---
mood: <one lowercase word, e.g. contemplative, anxious, hopeful>
energy: <integer 1-10>
people: [<bare name>, <bare name>]
places: [<bare name>]
projects: [<bare name>]
topics: [<kebab-case-tag>, <kebab-case-tag>]
---SUMMARY---
> *<single poetic line capturing essence>*

<first-person narrative paragraph (1-3 sentences) as if user is writing in their own diary using "I" / "my". Use [[Name]] for entities listed in frontmatter.>

#emotion/<one> #topic/<one> #relation/<one>

RULES:
- Reply in user's language (auto-detect).
- Frontmatter arrays may be empty — write \`[]\` if none.
- Topic tags: kebab-case, specific. AVOID generic: life, feeling, diary, journal, day.
- Do NOT echo conversation verbatim.
- ENTITY EXTRACTION (people/places/projects) — STRICT: only specific proper nouns that could be a Wikipedia article. Skip software/tools (telegram, obsidian, claude, gpt, ai, plugin), generic role words ("mom", "boss", "friend"), abstract concepts.
`.trim();

export interface ParsedFinalize {
  frontmatter: any;
  body: string;
}

/** Run DeepSeek summarize on conversation, return parsed result. */
export async function summarizeConversation(
  ctx: Array<{ role: 'user' | 'assistant'; content: string }>,
  topicProfile: string | null,
  env: Env
): Promise<ParsedFinalize | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  const systemPrompt = topicProfile
    ? `${SUMMARY_SYSTEM_PROMPT}\n\n## Topic Profile (user context — for nuance, do not echo)\n${topicProfile}`
    : SUMMARY_SYSTEM_PROMPT;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 800,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Please summarize this conversation:\n\n' + ctx.map((m) => `${m.role}: ${m.content}`).join('\n\n') },
        ],
      }),
    });
    if (!res.ok) {
      console.error('[summarize] non-ok', res.status, await res.text());
      return null;
    }
    const j: any = await res.json();
    const raw: string = j?.choices?.[0]?.message?.content || '';
    return parseStructuredSummary(raw);
  } catch (e: any) {
    console.error('[summarize] failed', e?.message || e);
    return null;
  }
}

/** Parse the AI's two-section output. Mirrors plugin's parseStructuredSummary. */
export function parseStructuredSummary(raw: string): ParsedFinalize {
  const fmStart = raw.indexOf('---FRONTMATTER---');
  const fmEnd = raw.indexOf('---SUMMARY---');
  if (fmStart === -1 || fmEnd === -1 || fmEnd < fmStart) {
    return { frontmatter: {}, body: raw.trim() };
  }
  const fmBlock = raw.slice(fmStart + '---FRONTMATTER---'.length, fmEnd).trim();
  const body = raw.slice(fmEnd + '---SUMMARY---'.length).trim();
  return { frontmatter: parseSimpleYaml(fmBlock), body };
}

/** Tiny YAML subset parser — handles `key: value` and `key: [a, b]`. */
function parseSimpleYaml(block: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const v = rawVal.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      // Array — split on comma, strip quotes/brackets
      const inner = v.slice(1, -1).trim();
      out[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
    } else if (/^\d+$/.test(v)) {
      out[key] = parseInt(v, 10);
    } else {
      out[key] = v.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

/** Persist the finalize packet to D1 for plugin to pull and write to vault. */
export async function persistFinalizePacket(
  userId: string,
  date: string,
  topic: string | null,
  parsed: ParsedFinalize,
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>,
  photoIds: string[],
  env: Env
): Promise<number | null> {
  if (!env.DB) return null;
  try {
    const ins = await env.DB
      .prepare(
        `INSERT INTO finalize_packets (user_id, date, topic, frontmatter_json, body, transcript_json, photo_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        userId,
        date,
        topic || null,
        JSON.stringify(parsed.frontmatter),
        parsed.body,
        JSON.stringify(transcript),
        JSON.stringify(photoIds)
      )
      .run();
    return (ins.meta as any).last_row_id || null;
  } catch (e: any) {
    console.error('[persistFinalizePacket] failed', e?.message || e);
    return null;
  }
}

/** Plugin pulls + drains. Returns and deletes finalize packets for a user. */
export async function drainFinalizePackets(
  userId: string,
  env: Env
): Promise<Array<{ id: number; date: string; topic: string | null; frontmatter: any; body: string; transcript: any[]; photo_ids: string[] }>> {
  if (!env.DB) return [];
  try {
    const rows = await env.DB
      .prepare('SELECT id, date, topic, frontmatter_json, body, transcript_json, photo_ids_json FROM finalize_packets WHERE user_id = ? ORDER BY id ASC LIMIT 50')
      .bind(userId)
      .all<{ id: number; date: string; topic: string | null; frontmatter_json: string; body: string; transcript_json: string; photo_ids_json: string }>();
    const list = (rows.results as any) || [];
    if (list.length === 0) return [];
    const ids = list.map((r: any) => r.id);
    // Delete after read so plugin gets each packet once.
    const placeholders = ids.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM finalize_packets WHERE id IN (${placeholders})`).bind(...ids).run();
    return list.map((r: any) => ({
      id: r.id,
      date: r.date,
      topic: r.topic,
      frontmatter: safeParseJson(r.frontmatter_json, {}),
      body: r.body,
      transcript: safeParseJson(r.transcript_json, []),
      photo_ids: safeParseJson(r.photo_ids_json, []),
    }));
  } catch (e: any) {
    console.error('[drainFinalizePackets] failed', e?.message || e);
    return [];
  }
}

function safeParseJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s); } catch { return fallback; }
}
