import { App, TFile, normalizePath } from 'obsidian';
import { closest, distance } from 'fastest-levenshtein';

export type EntityType = 'person' | 'place' | 'project';

export interface EntityFolders {
  person: string;
  place: string;
  project: string;
}

// Generic / tool-name leakage from LLM extraction — never create entity notes for these.
const BLOCK_LIST = new Set([
  'telegram', 'obsidian', 'claude', 'gpt', 'chatgpt', 'openai', 'deepseek',
  'ai', 'plugin', 'tool', 'bot', 'app', 'api', 'sdk', 'cli', 'github',
  'discord', 'slack', 'twitter', 'whatsapp', 'wechat',
]);

/**
 * Auto-create stub notes for people/places/projects mentioned in diary entries.
 * Each stub is a Dataview-friendly hub. Variants (typos, granularity) are
 * folded into the canonical note's `aliases:` frontmatter (Obsidian-native
 * alias mechanism, indexed for graph + search).
 */
export class EntityNotes {
  private app: App;
  private folders: EntityFolders;

  constructor(app: App, folders: EntityFolders) {
    this.app = app;
    this.folders = folders;
  }

  updateFolders(folders: EntityFolders) {
    this.folders = folders;
  }

  /**
   * Returns canonical note path. Creates stub if missing. Folds variants
   * (Levenshtein ≤ 2 OR substring) into existing note's aliases.
   * Empty / blocked / invalid → empty string.
   */
  async ensureEntityNote(name: string, type: EntityType): Promise<string> {
    const sanitized = sanitizeFileName(name);
    if (!sanitized) return '';
    if (BLOCK_LIST.has(sanitized.toLowerCase())) return '';

    const folder = normalizePath(this.folders[type] || defaultFolder(type));
    await this.ensureFolderExists(folder);

    // Fuzzy dedup: scan existing notes + their aliases in this folder.
    const candidates = this.collectCandidates(folder);
    const match = findFuzzyMatch(sanitized, candidates);
    if (match) {
      // Add new name as alias to canonical note (if not already canonical/aliased).
      const canonicalPath = normalizePath(`${folder}/${match.canonical}.md`);
      const file = this.app.vault.getAbstractFileByPath(canonicalPath);
      if (file instanceof TFile && match.canonical !== sanitized) {
        await this.addAlias(file, sanitized);
      }
      return canonicalPath;
    }

    // No match — create new entity note.
    const path = normalizePath(`${folder}/${sanitized}.md`);
    const today = todayStr();
    const content = renderTemplate(sanitized, type, today);
    try {
      await this.app.vault.create(path, content);
    } catch (e) {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
        console.error('Diary Bot: failed to create entity note', path, e);
        return '';
      }
    }
    return path;
  }

  /** Collect all entity names + aliases in a folder. */
  private collectCandidates(folder: string): EntityCandidate[] {
    const out: EntityCandidate[] = [];
    for (const file of this.app.vault.getFiles()) {
      if (!file.path.startsWith(folder + '/')) continue;
      if (file.extension !== 'md') continue;
      const canonical = file.basename;
      const cache = this.app.metadataCache.getFileCache(file);
      const aliases = readAliases(cache);
      out.push({ canonical, names: [canonical, ...aliases] });
    }
    return out;
  }

  private async addAlias(file: TFile, newAlias: string): Promise<void> {
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const existing: string[] = Array.isArray(fm.aliases)
          ? fm.aliases.map(String)
          : (typeof fm.aliases === 'string' && fm.aliases ? [fm.aliases] : []);
        if (!existing.some((a) => a.toLowerCase() === newAlias.toLowerCase())) {
          existing.push(newAlias);
          fm.aliases = existing;
        }
      });
    } catch (e) {
      console.error('Diary Bot: addAlias failed', e);
    }
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    if (!folderPath) return;
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // already exists race
        }
      }
    }
  }
}

interface EntityCandidate {
  canonical: string;
  names: string[]; // canonical + aliases
}

interface FuzzyMatch {
  canonical: string;
  matchedName: string;
}

/**
 * Find an existing entity that matches `name` by:
 *  - exact match (case-insensitive after normalize)
 *  - Levenshtein distance ≤ 2 on normalized form (typo)
 *  - substring containment (granularity: "obsidian-tool" matches "obsidian")
 * Returns null if no candidate close enough.
 */
function findFuzzyMatch(name: string, candidates: EntityCandidate[]): FuzzyMatch | null {
  const normNew = normalize(name);
  if (!normNew) return null;

  // Flatten all name variants with their canonical owner.
  const flat: Array<{ canonical: string; raw: string; norm: string }> = [];
  for (const c of candidates) {
    for (const n of c.names) {
      const nn = normalize(n);
      if (nn) flat.push({ canonical: c.canonical, raw: n, norm: nn });
    }
  }
  if (flat.length === 0) return null;

  // 1. Exact normalized match.
  for (const f of flat) {
    if (f.norm === normNew) return { canonical: f.canonical, matchedName: f.raw };
  }

  // 2. Substring (granularity collapse).
  for (const f of flat) {
    if (
      (f.norm.length >= 4 && normNew.includes(f.norm)) ||
      (normNew.length >= 4 && f.norm.includes(normNew))
    ) {
      return { canonical: f.canonical, matchedName: f.raw };
    }
  }

  // 3. Levenshtein on normalized form (typo).
  const norms = flat.map((f) => f.norm);
  const best = closest(normNew, norms);
  const bestIdx = norms.indexOf(best);
  if (bestIdx >= 0) {
    const d = distance(normNew, best);
    const maxLen = Math.max(normNew.length, best.length);
    // distance ≤ 2 absolute, OR ≤ 20% of length, whichever stricter
    if (d <= 2 || d / maxLen <= 0.2) {
      return { canonical: flat[bestIdx].canonical, matchedName: flat[bestIdx].raw };
    }
  }

  return null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

function readAliases(cache: any): string[] {
  const fm = cache?.frontmatter;
  if (!fm) return [];
  const a = fm.aliases;
  if (Array.isArray(a)) return a.map(String);
  if (typeof a === 'string' && a) return [a];
  return [];
}

function defaultFolder(type: EntityType): string {
  if (type === 'person') return 'Journal/People';
  if (type === 'place') return 'Journal/Places';
  return 'Journal/Projects';
}

function sanitizeFileName(name: string): string {
  if (!name) return '';
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return '';
  return cleaned;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function renderTemplate(name: string, type: EntityType, today: string): string {
  return `---
type: ${type}
name: ${name}
first-mentioned: ${today}
tags: [${type}]
aliases: []
---

# ${name}

## Recent diary mentions

\`\`\`dataview
LIST
FROM "Journal"
WHERE contains(file.outlinks, [[${name}]]) AND file.name != "${name}"
SORT file.day DESC
LIMIT 20
\`\`\`

> _If you don't have the Dataview plugin installed, the block above stays as a code block. Backlinks still appear under the Backlinks panel in Obsidian._
`;
}
