import type { Env } from './index';

export interface EntityMention {
  name: string;
  type: 'person' | 'place' | 'project';
  date: string;
  entry_path?: string;
  mood?: string;
}

/**
 * Upsert entity + record mention. Returns entity id.
 * Schema: see worker/src/schema.sql
 */
export async function upsertEntityMention(
  userId: string,
  m: EntityMention,
  env: Env
): Promise<number | null> {
  if (!env.DB) return null;
  try {
    // Find or insert entity
    const found = await env.DB
      .prepare('SELECT id FROM entities WHERE user_id = ? AND name = ? AND type = ?')
      .bind(userId, m.name, m.type)
      .first<{ id: number }>();
    let entityId: number;
    if (found) {
      entityId = found.id;
      await env.DB
        .prepare('UPDATE entities SET last_seen = ?, mention_count = mention_count + 1 WHERE id = ?')
        .bind(m.date, entityId)
        .run();
    } else {
      const ins = await env.DB
        .prepare(
          'INSERT INTO entities (user_id, name, type, first_seen, last_seen, mention_count) VALUES (?, ?, ?, ?, ?, 1)'
        )
        .bind(userId, m.name, m.type, m.date, m.date)
        .run();
      entityId = (ins.meta as any).last_row_id as number;
    }
    // Record mention
    await env.DB
      .prepare('INSERT INTO mentions (entity_id, user_id, date, entry_path, mood) VALUES (?, ?, ?, ?, ?)')
      .bind(entityId, userId, m.date, m.entry_path || null, m.mood || null)
      .run();
    return entityId;
  } catch (e: any) {
    console.error('[upsertEntityMention] failed', e?.message || e);
    return null;
  }
}

/** Increment co-occurrence weight between two entities (any order). */
export async function recordCooccurrence(
  userId: string,
  a: number,
  b: number,
  env: Env
): Promise<void> {
  if (!env.DB || a === b) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  try {
    await env.DB
      .prepare(
        `INSERT INTO cooccurrences (user_id, entity_a_id, entity_b_id, weight) VALUES (?, ?, ?, 1)
         ON CONFLICT(user_id, entity_a_id, entity_b_id) DO UPDATE SET weight = weight + 1`
      )
      .bind(userId, lo, hi)
      .run();
  } catch (e: any) {
    console.error('[recordCooccurrence] failed', e?.message || e);
  }
}

/** Search entities by name substring (case-insensitive) for a user. */
export async function searchEntitiesByName(
  userId: string,
  query: string,
  env: Env
): Promise<Array<{ id: number; name: string; type: string; mention_count: number; last_seen: string }>> {
  if (!env.DB || !query.trim()) return [];
  const q = `%${query.trim().toLowerCase()}%`;
  try {
    const res = await env.DB
      .prepare(
        `SELECT id, name, type, mention_count, last_seen FROM entities
         WHERE user_id = ? AND lower(name) LIKE ?
         ORDER BY mention_count DESC LIMIT 10`
      )
      .bind(userId, q)
      .all<{ id: number; name: string; type: string; mention_count: number; last_seen: string }>();
    return (res.results as any) || [];
  } catch (e: any) {
    console.error('[searchEntitiesByName] failed', e?.message || e);
    return [];
  }
}

/** Entities not mentioned in last `days` days. For smart reminders. */
export async function staleEntities(
  userId: string,
  days: number,
  env: Env
): Promise<Array<{ id: number; name: string; type: string; last_seen: string; mention_count: number }>> {
  if (!env.DB) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  try {
    const res = await env.DB
      .prepare(
        `SELECT id, name, type, last_seen, mention_count FROM entities
         WHERE user_id = ? AND last_seen < ? AND mention_count >= 2
         ORDER BY mention_count DESC LIMIT 5`
      )
      .bind(userId, cutoffStr)
      .all<{ id: number; name: string; type: string; last_seen: string; mention_count: number }>();
    return (res.results as any) || [];
  } catch (e: any) {
    console.error('[staleEntities] failed', e?.message || e);
    return [];
  }
}

/** All entities + mentions for graph view, scoped to a user. */
export async function entityGraph(
  userId: string,
  env: Env
): Promise<{ nodes: Array<{ id: number; name: string; type: string; mention_count: number; last_seen: string }>; edges: Array<{ a: number; b: number; weight: number }> }> {
  const empty = { nodes: [], edges: [] };
  if (!env.DB) return empty;
  try {
    const nodes = await env.DB
      .prepare('SELECT id, name, type, mention_count, last_seen FROM entities WHERE user_id = ? ORDER BY mention_count DESC LIMIT 200')
      .bind(userId)
      .all();
    const edges = await env.DB
      .prepare(
        `SELECT entity_a_id AS a, entity_b_id AS b, weight FROM cooccurrences
         WHERE user_id = ? AND weight >= 1 ORDER BY weight DESC LIMIT 1000`
      )
      .bind(userId)
      .all();
    return {
      nodes: ((nodes.results as any) || []),
      edges: ((edges.results as any) || []),
    };
  } catch (e: any) {
    console.error('[entityGraph] failed', e?.message || e);
    return empty;
  }
}
