import { App, TFile, Notice } from 'obsidian';
import { distance } from 'fastest-levenshtein';

const BLOCK_LIST = new Set([
  'telegram', 'obsidian', 'claude', 'gpt', 'chatgpt', 'openai', 'deepseek',
  'ai', 'plugin', 'tool', 'bot', 'app', 'api', 'sdk', 'cli', 'github',
  'discord', 'slack', 'twitter', 'whatsapp', 'wechat',
]);

interface Cluster {
  canonical: TFile;
  members: TFile[];
}

/**
 * One-shot cleanup pass for entity folders. Steps:
 *   1. Delete blocklisted notes (telegram, obsidian, claude, etc.).
 *   2. Cluster remaining by name similarity (Levenshtein ≤ 2 / substring).
 *   3. Pick canonical = longest name (most specific) or most-mentioned.
 *   4. Merge members → canonical's aliases frontmatter.
 *   5. Rewrite all wikilinks across vault to point to canonical.
 *   6. Delete merged member files.
 */
export async function cleanupEntities(
  app: App,
  folders: string[],
  dryRun: boolean = false
): Promise<{ deletedBlocked: number; merged: number; linksRewritten: number }> {
  let deletedBlocked = 0;
  let merged = 0;
  let linksRewritten = 0;

  for (const folder of folders) {
    const files = app.vault.getFiles().filter((f) =>
      f.path.startsWith(folder + '/') && f.extension === 'md'
    );
    if (files.length === 0) continue;

    // Step 1: blocklist purge
    const survivors: TFile[] = [];
    for (const f of files) {
      if (BLOCK_LIST.has(f.basename.toLowerCase())) {
        if (!dryRun) {
          await rewriteLinksTo(app, f.basename, '', null); // strip wikilinks
          await app.vault.delete(f);
        }
        deletedBlocked++;
      } else {
        survivors.push(f);
      }
    }

    // Step 2: cluster
    const clusters = clusterByName(survivors);

    // Step 3-6: merge each cluster
    for (const cluster of clusters) {
      if (cluster.members.length === 0) continue;
      const canonical = cluster.canonical;
      for (const member of cluster.members) {
        if (member.path === canonical.path) continue;
        if (!dryRun) {
          await addAlias(app, canonical, member.basename);
          const rewriteCount = await rewriteLinksTo(app, member.basename, canonical.basename, canonical);
          linksRewritten += rewriteCount;
          await app.vault.delete(member);
        }
        merged++;
      }
    }
  }

  return { deletedBlocked, merged, linksRewritten };
}

function clusterByName(files: TFile[]): Cluster[] {
  const clusters: Cluster[] = [];
  const assigned = new Set<string>();

  // Sort longest-first so most-specific names become canonical.
  const sorted = [...files].sort((a, b) => b.basename.length - a.basename.length);

  for (const f of sorted) {
    if (assigned.has(f.path)) continue;
    const cluster: Cluster = { canonical: f, members: [f] };
    assigned.add(f.path);
    const normCanon = normalize(f.basename);

    for (const other of sorted) {
      if (other.path === f.path) continue;
      if (assigned.has(other.path)) continue;
      const normOther = normalize(other.basename);
      if (!normOther) continue;

      const d = distance(normCanon, normOther);
      const maxLen = Math.max(normCanon.length, normOther.length);
      const similar =
        d <= 2 ||
        d / maxLen <= 0.2 ||
        (normCanon.length >= 4 && normOther.includes(normCanon)) ||
        (normOther.length >= 4 && normCanon.includes(normOther));

      if (similar) {
        cluster.members.push(other);
        assigned.add(other.path);
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}

async function addAlias(app: App, file: TFile, alias: string): Promise<void> {
  try {
    await app.fileManager.processFrontMatter(file, (fm) => {
      const existing: string[] = Array.isArray(fm.aliases)
        ? fm.aliases.map(String)
        : (typeof fm.aliases === 'string' && fm.aliases ? [fm.aliases] : []);
      if (!existing.some((a) => a.toLowerCase() === alias.toLowerCase())) {
        existing.push(alias);
        fm.aliases = existing;
      }
    });
  } catch (e) {
    console.error('cleanupEntities: addAlias failed', e);
  }
}

/** Rewrite all `[[oldName]]` and `[[oldName|...]]` in vault to `[[newName]]`. */
async function rewriteLinksTo(
  app: App,
  oldName: string,
  newName: string,
  _newFile: TFile | null
): Promise<number> {
  let count = 0;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match [[oldName]] or [[oldName|alias]] (basename only — not full paths).
  const pattern = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, 'g');
  for (const f of app.vault.getMarkdownFiles()) {
    const text = await app.vault.cachedRead(f);
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const replaced = text.replace(pattern, (_m, alias) => {
      count++;
      if (!newName) return ''; // blocklist purge — strip link
      return `[[${newName}${alias || ''}]]`;
    });
    if (replaced !== text) {
      await app.vault.modify(f, replaced);
    }
  }
  return count;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

/** Convenience helper to wire as Obsidian command. */
export function notifyCleanupResult(result: { deletedBlocked: number; merged: number; linksRewritten: number }) {
  new Notice(
    `Entity cleanup: removed ${result.deletedBlocked} blocked, merged ${result.merged}, rewrote ${result.linksRewritten} links.`,
    8000
  );
}
