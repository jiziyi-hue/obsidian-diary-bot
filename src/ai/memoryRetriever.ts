import { App, TFile, normalizePath } from 'obsidian';
import { AIRouter } from './aiRouter';
import { diaryPath } from '../vault/noteWriter';
import { TAG_AND_ENTITY_EXTRACTION_PROMPT } from './prompts';

const TOPIC_STOPLIST = new Set([
  'life', 'feeling', 'feelings', 'diary', 'journal', 'day', 'today',
  'thing', 'things', 'stuff', 'general', 'misc',
]);

export interface MemoryFolders {
  diary: string;
  person: string;
  place: string;
  project: string;
}

export interface MemoryBlocks {
  recency: string;
  entityLinked: string;
  tagMatched: string;
}

/**
 * Three-layer memory: recent days + entity-linked past entries + tag-overlap past entries.
 * Uses Obsidian's native metadataCache — no external index, no embeddings.
 */
const MEMORY_TOKEN_BUDGET = 8000;
const WEIGHT_RECENCY = 3;
const WEIGHT_ENTITY = 2;
const WEIGHT_TAG = 1;

export class MemoryRetriever {
  private app: App;
  private ai: AIRouter;
  private folders: MemoryFolders;
  vaultWideSearch = false;

  constructor(app: App, ai: AIRouter, folders: MemoryFolders) {
    this.app = app;
    this.ai = ai;
    this.folders = folders;
  }

  updateFolders(folders: MemoryFolders) {
    this.folders = folders;
  }

  rebuild(ai: AIRouter) {
    this.ai = ai;
  }

  // ── Tag/entity extraction (single AI call per session) ──

  async extractTagsAndEntities(message: string): Promise<{ entities: string[]; tags: string[] }> {
    const fallback = { entities: [], tags: [] };
    if (!message?.trim()) return fallback;
    try {
      const raw = await this.ai.chat(
        TAG_AND_ENTITY_EXTRACTION_PROMPT,
        [{ role: 'user', content: message }]
      );
      const json = extractJsonObject(raw);
      if (!json) return fallback;
      const entities = Array.isArray(json.entities)
        ? json.entities.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim()).slice(0, 4)
        : [];
      const tags = Array.isArray(json.tags)
        ? json.tags
            .filter((s: any) => typeof s === 'string' && s.trim())
            .map((s: string) => s.trim().toLowerCase().replace(/^#+/, ''))
            .filter((t: string) => !TOPIC_STOPLIST.has(t))
            .slice(0, 4)
        : [];
      return { entities, tags };
    } catch (e) {
      console.error('Diary Bot: extractTagsAndEntities failed', e);
      return fallback;
    }
  }

  // ── Recency layer ──

  async getRecencyMemory(days: number, excludeToday: boolean = true): Promise<string> {
    if (!days || days <= 0) return '';
    const folder = normalizePath(this.folders.diary || 'Journal');
    const blocks: string[] = [];
    const start = excludeToday ? 1 : 0;
    for (let i = start; i < start + days; i++) {
      const dateStr = dateNDaysAgo(i);
      const path = diaryPath(folder, dateStr);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        try {
          const snippet = await this.readSnippet(file, dateStr);
          if (snippet) blocks.push(snippet);
        } catch {
          // ignore unreadable
        }
      }
    }
    return blocks.join('\n\n');
  }

  /** Prefer frontmatter description; fall back to truncated body. */
  private async readSnippet(file: TFile, label: string): Promise<string> {
    const cache = this.app.metadataCache.getFileCache(file);
    const desc = (cache?.frontmatter as any)?.description;
    if (typeof desc === 'string' && desc.trim()) {
      return `=== ${label} ===\n${desc.trim()}`;
    }
    const text = await this.app.vault.cachedRead(file);
    if (!text.trim()) return '';
    const body = stripFrontmatter(text).trim();
    return `=== ${label} ===\n${truncateText(body, 300)}`;
  }

  // ── Entity-linked layer ──

  async getEntityLinkedMemory(entities: string[], topK: number, excludeDays: number): Promise<string> {
    if (!entities?.length) return '';
    // Resolve entity names to canonical entity-note paths (across all 3 folders).
    const entityPaths: string[] = [];
    for (const name of entities) {
      const candidates = [
        normalizePath(`${this.folders.person}/${name}.md`),
        normalizePath(`${this.folders.place}/${name}.md`),
        normalizePath(`${this.folders.project}/${name}.md`),
      ];
      for (const p of candidates) {
        if (this.app.vault.getAbstractFileByPath(p)) entityPaths.push(p);
      }
    }
    if (!entityPaths.length) return '';

    // resolvedLinks: { sourcePath: { targetPath: count } }
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    const diaryFolder = normalizePath(this.folders.diary || 'Journal');
    const excludeSet = new Set<string>();
    for (let i = 0; i < excludeDays; i++) {
      excludeSet.add(diaryPath(diaryFolder, dateNDaysAgo(i)));
    }

    const scores = new Map<string, number>();
    for (const [sourcePath, targets] of Object.entries(resolved)) {
      if (excludeSet.has(sourcePath)) continue;
      const isDiary = sourcePath.startsWith(diaryFolder + '/');
      if (!isDiary && !this.vaultWideSearch) continue;
      const targetMap = targets as Record<string, number>;
      let hits = 0;
      for (const ep of entityPaths) {
        if (targetMap[ep]) hits++;
      }
      if (hits > 0) scores.set(sourcePath, isDiary ? hits * 3 : hits);
    }
    return await this.readTopK(scores, topK, 'entity');
  }

  // ── Tag-overlap layer ──

  async getTagMatchedMemory(tags: string[], topK: number, excludeDays: number): Promise<string> {
    if (!tags?.length) return '';

    const diaryFolder = normalizePath(this.folders.diary || 'Journal');
    const excludeSet = new Set<string>();
    for (let i = 0; i < excludeDays; i++) {
      excludeSet.add(diaryPath(diaryFolder, dateNDaysAgo(i)));
    }
    const want = new Set(tags.map((t) => normalizeTag(t)));

    const scores = new Map<string, number>();
    const allFiles = this.app.vault.getMarkdownFiles();
    for (const f of allFiles) {
      if (excludeSet.has(f.path)) continue;
      const isDiary = f.path.startsWith(diaryFolder + '/');
      if (!isDiary && !this.vaultWideSearch) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      const fileTags = cache?.tags?.map((t) => normalizeTag(t.tag)) ?? [];
      const fmTags = (cache?.frontmatter as any)?.tags;
      const fmTagArr = Array.isArray(fmTags) ? fmTags.map((t: any) => normalizeTag(String(t))) : [];
      const allTags = new Set([...fileTags, ...fmTagArr]);
      let hits = 0;
      for (const t of want) {
        for (const ft of allTags) {
          if (ft === t || ft.endsWith('/' + t) || t.endsWith('/' + ft)) {
            hits++;
            break;
          }
        }
      }
      if (hits > 0) scores.set(f.path, isDiary ? hits * 3 : hits);
    }
    return await this.readTopK(scores, topK, 'tag');
  }

  // ── Compose with token budget ──

  composeMemoryBlock(blocks: MemoryBlocks): string {
    const budget = MEMORY_TOKEN_BUDGET;
    let remaining = budget;
    const parts: string[] = [];

    const layers: Array<{ text: string; weight: number; header: string }> = [];
    if (blocks.entityLinked.trim()) {
      layers.push({ text: blocks.entityLinked.trim(), weight: WEIGHT_ENTITY, header: '### Past entries linked to mentioned people/places' });
    }
    if (blocks.recency.trim()) {
      layers.push({ text: blocks.recency.trim(), weight: WEIGHT_RECENCY, header: '### Recent days' });
    }
    if (blocks.tagMatched.trim()) {
      layers.push({ text: blocks.tagMatched.trim(), weight: WEIGHT_TAG, header: '### Topically related past entries' });
    }

    layers.sort((a, b) => b.weight - a.weight);
    const totalWeight = layers.reduce((s, l) => s + l.weight, 0) || 1;

    for (const layer of layers) {
      if (remaining <= 50) break;
      const share = Math.floor(budget * (layer.weight / totalWeight));
      const allocated = Math.min(share, remaining);
      const truncated = truncateTokens(layer.text, allocated);
      if (truncated.trim()) {
        parts.push(`${layer.header}\n${truncated}`);
        remaining -= estimateTokens(truncated);
      }
    }

    return parts.join('\n\n');
  }

  // ── helpers ──

  private async readTopK(scores: Map<string, number>, topK: number, label: string): Promise<string> {
    if (scores.size === 0) return '';
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, topK);
    const blocks: string[] = [];
    for (const [path] of sorted) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      try {
        const snippet = await this.readSnippet(file, `${file.basename} (${label}-match)`);
        if (snippet) blocks.push(snippet);
      } catch {
        // skip
      }
    }
    return blocks.join('\n\n');
  }
}

// ── module helpers ──

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function normalizeTag(t: string): string {
  return t.replace(/^#+/, '').toLowerCase().trim();
}

function stripFrontmatter(text: string): string {
  const match = text.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? text.slice(match[0].length) : text;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf(' ', maxChars);
  return text.slice(0, cut > 0 ? cut : maxChars) + '…';
}

function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

function truncateTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let result = '';
  let used = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const isCjk = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
    const cost = isCjk ? 1 / 1.5 : 1 / 4;
    if (used + cost > maxTokens) break;
    result += ch;
    used += cost;
  }
  return result.trimEnd() + '…';
}

function extractJsonObject(raw: string): any | null {
  if (!raw) return null;
  // Strip code fences if AI added them.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  // Find first { ... matching } block.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
