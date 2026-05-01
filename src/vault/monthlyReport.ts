import { normalizePath, TFile } from 'obsidian';
import type DiaryBotPlugin from '../main';
import { diaryPath } from './noteWriter';
import { MONTHLY_REVIEW_PROMPT } from '../ai/prompts';

export class MonthlyReportGenerator {
  private plugin: DiaryBotPlugin;

  constructor(plugin: DiaryBotPlugin) {
    this.plugin = plugin;
  }

  async checkAndGenerate(): Promise<void> {
    const folder = normalizePath((this.plugin.settings.diaryFolder || 'Journal') + '/Monthly');
    await this.ensureFolder(folder);

    const today = new Date();
    const isLastDay = today.getDate() === new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const isPast = today.getDate() >= 2 && today.getMonth() !== new Date(today.getFullYear(), today.getMonth(), 1).getMonth();
    const shouldGenerate = isLastDay || (isPast && today.getDate() <= 3);

    if (!shouldGenerate) return;

    const targetMonth = isPast ? today.getMonth() - 1 : today.getMonth();
    const targetYear = targetMonth < 0 ? today.getFullYear() - 1 : today.getFullYear();
    const realMonth = targetMonth < 0 ? 11 : targetMonth;

    const monthKey = `${targetYear}-${pad(realMonth + 1)}`;
    const reportPath = normalizePath(`${folder}/${monthKey}.md`);

    if (this.plugin.app.vault.getAbstractFileByPath(reportPath)) return;

    const state = await this.plugin.reportState.load();
    if (state.lastMonthly === monthKey) return;

    const entries = await this.collectMonthEntries(targetYear, realMonth);
    if (entries.length === 0) return;

    const report = await this.generateReport(entries, targetYear, realMonth);
    await this.plugin.app.vault.create(reportPath, report);

    await this.plugin.reportState.update({ lastMonthly: monthKey });
  }

  private async collectMonthEntries(year: number, month: number): Promise<Array<{
    date: string; mood: string; energy: number; desc: string;
    people: string; topics: string;
  }>> {
    const folder = normalizePath(this.plugin.settings.diaryFolder || 'Journal');
    const entries: Array<{ date: string; mood: string; energy: number; desc: string; people: string; topics: string }> = [];
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
      const path = diaryPath(folder, dateStr);
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const fm = (cache?.frontmatter || {}) as any;
        entries.push({
          date: dateStr,
          mood: fm.mood || '',
          energy: typeof fm.energy === 'number' ? fm.energy : 0,
          desc: fm.description || '',
          people: Array.isArray(fm.people) ? fm.people.map((p: string) => String(p).replace(/\[\[|\]\]/g, '')).join(',') : '',
          topics: Array.isArray(fm.topics) ? fm.topics.join(',') : '',
        });
      }
    }
    return entries;
  }

  private async generateReport(
    entries: Array<{ date: string; mood: string; energy: number; desc: string; people: string; topics: string }>,
    year: number, month: number
  ): Promise<string> {
    const moods = entries.filter(e => e.mood).map(e => e.mood);
    const energies = entries.filter(e => e.energy > 0).map(e => e.energy);
    const avgMood = moods.length > 0 ? (moods.map(moodScore).reduce((a, b) => a + b, 0) / moods.length).toFixed(1) : '—';
    const avgEnergy = energies.length > 0 ? (energies.reduce((a, b) => a + b, 0) / energies.length).toFixed(1) : '—';

    const peopleAll = entries.flatMap(e => e.people ? e.people.split(',').filter(Boolean) : []);
    const peopleTop = topN(freq(peopleAll), 3);
    const placesAll: string[] = []; // collected from individual entries
    const topicsAll = entries.flatMap(e => e.topics ? e.topics.split(',').filter(Boolean) : []);
    const topicsTop = topN(freq(topicsAll), 3);

    const tableRows = entries.map(e =>
      `| [[${e.date}]] | ${moodToEmoji(e.mood)} ${e.mood || '—'} | ${e.energy || '—'} | ${e.desc.slice(0, 60)} |`
    ).join('\n');

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    const dataBlock = entries.map(e =>
      `${e.date} | mood:${e.mood} | energy:${e.energy} | people:${e.people} | topics:${e.topics} | ${e.desc}`
    ).join('\n');

    const summary = await this.plugin.aiRouter.chat(MONTHLY_REVIEW_PROMPT.replace('{Month}', monthNames[month]).replace('{Year}', String(year)).replace('{count}', String(entries.length)).replace('{avg_mood}', String(avgMood)).replace('{avg_energy}', String(avgEnergy)).replace('{people}', peopleTop.join(', ') || '—').replace('{places}', '—'), [
      { role: 'user', content: `Monthly diary data:\n${dataBlock}` }
    ]);

    return [
      `# ${monthNames[month]} ${year} — Monthly Review`,
      '',
      `| Date | Mood | Energy | Summary |`,
      `|------|------|--------|---------|`,
      tableRows,
      '',
      summary,
      '',
      `> Auto-generated monthly report. Click any date to open that day's diary.`,
    ].join('\n');
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split('/');
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.plugin.app.vault.getAbstractFileByPath(cur)) {
        try { await this.plugin.app.vault.createFolder(cur); } catch { /* race */ }
      }
    }
  }
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
function freq(arr: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of arr) { const t = s.trim(); if (t) m.set(t, (m.get(t) || 0) + 1); }
  return m;
}
function topN(m: Map<string, number>, n: number): string[] {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}
function moodScore(mood: string): number {
  const s = mood.toLowerCase();
  if (s.includes('happy') || s.includes('excited') || s.includes('grateful')) return 8;
  if (s.includes('hopeful') || s.includes('calm') || s.includes('peaceful')) return 7;
  if (s.includes('contemplative') || s.includes('reflective')) return 6;
  if (s.includes('tired') || s.includes('anxious') || s.includes('worried')) return 4;
  if (s.includes('sad') || s.includes('frustrated') || s.includes('angry')) return 3;
  return 5;
}
function moodToEmoji(mood: string): string {
  const m = (mood || '').toLowerCase();
  if (m.includes('anxious')) return '😰';
  if (m.includes('sad')) return '😢';
  if (m.includes('angry') || m.includes('frustrated')) return '😤';
  if (m.includes('happy') || m.includes('excited')) return '😊';
  if (m.includes('calm') || m.includes('peaceful')) return '😌';
  if (m.includes('tired')) return '😴';
  if (m.includes('hopeful') || m.includes('optimistic')) return '🌱';
  if (m.includes('grateful')) return '🙏';
  if (m.includes('contemplative') || m.includes('reflective')) return '🤔';
  return '💭';
}
