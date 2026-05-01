import { TFile, TFolder, normalizePath } from 'obsidian';
import type DiaryBotPlugin from '../main';

/**
 * Sync worker D1 topic_profiles → vault `Topics/<key>.md` (read-only mirror).
 * + Watch local edits → reverse-push to worker.
 * + Backfill: scan existing daily entries for topics+entities, push to worker
 *   so D1 starts from current vault state (one-shot import).
 */

interface RemoteProfile {
  topic: string;
  user_profile: string;
  themes: string[];
  mention_count: number;
  last_updated: string | null;
}

const TOPIC_FOLDER = (plugin: DiaryBotPlugin) => `${plugin.settings.diaryFolder || 'Journal'}/Topics`;

const TOPIC_META: Record<string, { emoji: string; en: string; zh: string }> = {
  work: { emoji: '💼', en: 'Work', zh: '工作' },
  friend: { emoji: '👫', en: 'Friends', zh: '朋友' },
  family: { emoji: '👨‍👩‍👧', en: 'Family', zh: '家' },
  love: { emoji: '💕', en: 'Love', zh: '感情' },
  self: { emoji: '🧠', en: 'Self', zh: '自我' },
  goal: { emoji: '🎯', en: 'Goals', zh: '目标' },
  health: { emoji: '🌱', en: 'Health', zh: '健康' },
  random: { emoji: '💭', en: 'Random', zh: '随便聊' },
};

/** Sync all profiles D1 → vault. Idempotent. */
export async function syncTopicProfilesFromCloud(plugin: DiaryBotPlugin): Promise<void> {
  const userId = plugin.settings.relayUserId;
  if (!userId) return;
  const profiles = await plugin.relayClient.fetchTopicProfiles(userId);
  if (profiles.length === 0) return;

  const folder = normalizePath(TOPIC_FOLDER(plugin));
  await plugin.noteWriter.ensureFolderExists(folder);

  for (const p of profiles) {
    if (p.topic === 'random') continue; // skip ephemeral
    const meta = TOPIC_META[p.topic] || { emoji: '🏷', en: p.topic, zh: p.topic };
    const path = normalizePath(`${folder}/${p.topic}.md`);
    const file = plugin.app.vault.getAbstractFileByPath(path);
    const content = renderTopicMd(p, meta);
    if (file instanceof TFile) {
      // Only overwrite if user hasn't manually changed since last_updated (avoid clobber).
      const cache = plugin.app.metadataCache.getFileCache(file);
      const localUpdated = (cache?.frontmatter as any)?.last_updated;
      if (localUpdated && p.last_updated && localUpdated > p.last_updated) {
        // Local newer — skip (user edited; push handler will reverse-sync).
        continue;
      }
      await plugin.app.vault.modify(file, content);
    } else {
      await plugin.app.vault.create(path, content);
    }
  }
}

function renderTopicMd(p: RemoteProfile, meta: { emoji: string; en: string; zh: string }): string {
  const themesList = p.themes.length ? p.themes.map((t: string) => `  - ${t.replace(/"/g, '\\"')}`).join('\n') : '';
  const fmThemes = p.themes.length ? `themes:\n${themesList}` : 'themes: []';
  return `---
type: topic
key: ${p.topic}
emoji: ${meta.emoji}
name_en: ${meta.en}
name_zh: ${meta.zh}
mention_count: ${p.mention_count}
last_updated: ${p.last_updated || ''}
${fmThemes}
---

# ${meta.emoji} ${meta.zh} / ${meta.en}

## User Profile (auto-evolved)

${p.user_profile || '_Profile builds up after several entries in this topic._'}

## Recent diary mentions

\`\`\`dataview
TABLE mood, energy, file.day as Date
FROM "${p.topic === 'random' ? 'Journal' : 'Journal'}"
WHERE contains(topics, "${p.topic}") OR contains(file.tags, "#${p.topic}")
SORT file.day DESC
LIMIT 30
\`\`\`

> Edit "User Profile" or "themes" in frontmatter — your changes auto-sync back to the cloud and AI will use them next reflection.
`;
}

/** Watch Topics/<key>.md modify events; reverse-push to worker. */
export function registerTopicReverseSync(plugin: DiaryBotPlugin): void {
  plugin.registerEvent(
    plugin.app.vault.on('modify', async (file) => {
      if (!(file instanceof TFile)) return;
      const folder = normalizePath(TOPIC_FOLDER(plugin));
      if (!file.path.startsWith(folder + '/')) return;
      if (file.extension !== 'md') return;

      // Debounce: collect edits, push 2s after last modify.
      const key = file.basename;
      clearTimeout(debounceTimers.get(key));
      debounceTimers.set(key, window.setTimeout(async () => {
        try {
          const cache = plugin.app.metadataCache.getFileCache(file);
          const fm = (cache?.frontmatter || {}) as any;
          if (fm.type !== 'topic' || !fm.key) return;
          const text = await plugin.app.vault.read(file);
          // Extract section under "## User Profile (auto-evolved)" up to next heading.
          const m = text.match(/##\s+User Profile.*?\n([\s\S]*?)(?=\n##\s+|$)/);
          const profileText = m ? m[1].trim().replace(/^_.*?_$/m, '').trim() : '';
          const themes: string[] = Array.isArray(fm.themes) ? fm.themes.map(String) : [];
          const userId = plugin.settings.relayUserId;
          if (!userId) return;
          await plugin.relayClient.pushTopicProfile(userId, fm.key, profileText, themes);
          console.log('[DiaryBot] reverse-synced topic', fm.key);
        } catch (e) {
          console.error('[DiaryBot] reverse-sync failed', e);
        }
      }, 2000));
    })
  );
}

const debounceTimers = new Map<string, number>();

/** One-shot backfill: scan all daily entries → POST entity mentions to worker D1. */
export async function backfillTopics(plugin: DiaryBotPlugin): Promise<{ scanned: number; pushed: number }> {
  const userId = plugin.settings.relayUserId;
  if (!userId) return { scanned: 0, pushed: 0 };
  const folder = normalizePath(plugin.settings.diaryFolder || 'Journal');
  const peopleFolder = normalizePath(plugin.settings.peopleFolder || `${folder}/People`);
  const placesFolder = normalizePath(plugin.settings.placesFolder || `${folder}/Places`);
  const projectsFolder = normalizePath(plugin.settings.projectsFolder || `${folder}/Projects`);

  const files = plugin.app.vault.getMarkdownFiles().filter((f) =>
    f.path.startsWith(folder + '/') && /^\d{4}-\d{2}-\d{2}$/.test(f.basename)
  );
  let scanned = 0;
  let pushed = 0;

  for (const f of files) {
    scanned++;
    const cache = plugin.app.metadataCache.getFileCache(f);
    const fm = (cache?.frontmatter || {}) as any;
    const mood = typeof fm.mood === 'string' ? fm.mood : '';

    // Frontmatter legacy lists (older entries had these arrays)
    const fmPeople = collectFmList(fm.people);
    const fmPlaces = collectFmList(fm.places);
    const fmProjects = collectFmList(fm.projects);

    // Inline wikilinks resolved by target folder (newer entries)
    const inlinePeople: string[] = [];
    const inlinePlaces: string[] = [];
    const inlineProjects: string[] = [];
    for (const link of cache?.links || []) {
      const dest = plugin.app.metadataCache.getFirstLinkpathDest(link.link, f.path);
      if (!dest) continue;
      if (dest.path.startsWith(peopleFolder + '/')) inlinePeople.push(dest.basename);
      else if (dest.path.startsWith(placesFolder + '/')) inlinePlaces.push(dest.basename);
      else if (dest.path.startsWith(projectsFolder + '/')) inlineProjects.push(dest.basename);
    }

    const people = unique([...fmPeople, ...inlinePeople]);
    const places = unique([...fmPlaces, ...inlinePlaces]);
    const projects = unique([...fmProjects, ...inlineProjects]);
    if (people.length + places.length + projects.length === 0) continue;

    await plugin.relayClient.indexEntry(userId, {
      date: f.basename,
      path: f.path,
      mood,
      people,
      places,
      projects,
    });
    pushed++;
  }
  return { scanned, pushed };
}

function collectFmList(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).replace(/\[\[|\]\]/g, '').trim()).filter(Boolean);
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}
