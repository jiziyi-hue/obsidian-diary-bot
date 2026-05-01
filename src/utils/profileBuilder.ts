import { App, TFile } from 'obsidian';
import { pad } from './dateUtils';

/**
 * Scan last N days of diary entries, extract frontmatter, return compact profile
 * for injection into the worker's AI system prompt.
 */
export async function buildUserProfile(
  app: App,
  diaryFolder: string,
  days: number = 7
): Promise<string> {
  const folder = diaryFolder || 'Journal';
  const now = new Date();
  const moods: string[] = [];
  const energies: number[] = [];
  const peopleSet = new Set<string>();
  const topicsSet = new Set<string>();
  const descriptions: string[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const path = `${folder}/${dateStr}.md`;
    const af = app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile)) continue;

    const cache = app.metadataCache.getFileCache(af);
    const fm = (cache?.frontmatter || {}) as Record<string, any>;

    if (typeof fm.mood === 'string' && fm.mood) moods.push(fm.mood);
    if (typeof fm.energy === 'number' && fm.energy >= 1 && fm.energy <= 10) energies.push(fm.energy);
    if (Array.isArray(fm.people)) {
      for (const p of fm.people) {
        const name = String(p).replace(/^\[\[|\]\]$/g, '').trim();
        if (name) peopleSet.add(name);
      }
    }
    if (Array.isArray(fm.topics)) {
      for (const t of fm.topics) topicsSet.add(String(t).trim());
    }
    if (typeof fm.description === 'string' && fm.description) {
      descriptions.push(fm.description);
    }
  }

  const parts: string[] = [];

  if (moods.length > 0) {
    const moodCounts = new Map<string, number>();
    for (const m of moods) moodCounts.set(m, (moodCounts.get(m) || 0) + 1);
    const top = [...moodCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    parts.push(`Recent mood: ${top.map(([m, c]) => `${m} (${c}d)`).join(', ')}`);
  }

  if (energies.length > 0) {
    const avg = (energies.reduce((s, e) => s + e, 0) / energies.length).toFixed(1);
    parts.push(`Avg energy: ${avg}/10`);
  }

  if (peopleSet.size > 0) {
    parts.push(`People: ${[...peopleSet].slice(0, 8).join(', ')}`);
  }

  if (topicsSet.size > 0) {
    parts.push(`Topics: ${[...topicsSet].slice(0, 10).join(', ')}`);
  }

  if (descriptions.length > 0) {
    const recent = descriptions.slice(0, 3).map(d => `"${d}"`).join(' / ');
    parts.push(`Recent: ${recent}`);
  }

  return parts.length > 0 ? parts.join('. ') + '.' : '';
}
