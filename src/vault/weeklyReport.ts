import { normalizePath, TFile } from 'obsidian';
import type DiaryBotPlugin from '../main';
import { diaryPath } from './noteWriter';
import { WEEKLY_REPORT_SYSTEM_PROMPT } from '../ai/prompts';
import { pad, fmtDate, getLastSunday, getWeekNumber } from '../utils/dateUtils';

export class WeeklyReportGenerator {
  private plugin: DiaryBotPlugin;

  constructor(plugin: DiaryBotPlugin) {
    this.plugin = plugin;
  }

  /** Check if a weekly report is due and generate if needed. */
  async checkAndGenerate(): Promise<void> {
    const folder = normalizePath((this.plugin.settings.diaryFolder || 'Journal') + '/Weekly');
    await this.ensureFolder(folder);

    const today = new Date();
    if (today.getDay() === 0) return; // Sunday: week not complete yet, wait for Monday

    // Generate for the most-recently-completed Sun→Sat week (the Sunday just past).
    const weekEnd = getLastSunday(today);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 6);

    const weekNum = getWeekNumber(weekEnd);
    const year = weekEnd.getFullYear();
    const thisWeek = `${year}-W${pad(weekNum)}`;
    const reportPath = normalizePath(`${folder}/${thisWeek}.md`);

    // Already generated?
    if (this.plugin.app.vault.getAbstractFileByPath(reportPath)) return;

    const state = await this.plugin.reportState.load();
    if (state.lastWeekly === thisWeek) return;

    const entries = await this.collectWeekEntries(weekStart, weekEnd);
    if (entries.length === 0) return;

    const report = await this.generateReport(entries, weekStart, weekEnd);
    await this.plugin.app.vault.create(reportPath, report);

    await this.plugin.reportState.update({ lastWeekly: thisWeek });
  }

  private async collectWeekEntries(start: Date, end: Date): Promise<Array<{
    date: string; mood: string; energy: number; desc: string; entities: string[]; tasks: { open: number; done: number };
  }>> {
    const folder = normalizePath(this.plugin.settings.diaryFolder || 'Journal');
    const entries: Array<{ date: string; mood: string; energy: number; desc: string; entities: string[]; tasks: { open: number; done: number } }> = [];
    const d = new Date(start);
    while (d <= end) {
      const dateStr = fmtDate(d);
      const path = diaryPath(folder, dateStr);
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const fm = (cache?.frontmatter || {}) as any;
        const mood = fm.mood || '';
        const energy = typeof fm.energy === 'number' ? fm.energy : 0;
        const desc = fm.description || '';
        const text = await this.plugin.app.vault.cachedRead(file);
        // Inline wikilink entities
        const entities: string[] = [];
        for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
          const name = m[1].split('/').pop() || '';
          if (name && !/^\d{4}-\d{2}-\d{2}/.test(name)) entities.push(name);
        }
        // Tasks
        const open = (text.match(/^- \[ \] /gm) || []).length;
        const done = (text.match(/^- \[x\] /gim) || []).length;
        entries.push({ date: dateStr, mood, energy, desc, entities, tasks: { open, done } });
      }
      d.setDate(d.getDate() + 1);
    }
    return entries;
  }

  private async generateReport(
    entries: Array<{ date: string; mood: string; energy: number; desc: string; entities: string[]; tasks: { open: number; done: number } }>,
    start: Date, end: Date
  ): Promise<string> {
    const rows = entries.map(e =>
      `| ${e.date} | ${moodToEmoji(e.mood)} ${e.mood || '—'} | ${e.energy || '—'}/10 | [[${e.date}\|${e.desc.slice(0, 40)}${e.desc.length > 40 ? '…' : ''}]] |`
    ).join('\n');

    const table = `| Date | Mood | Energy | Entry |\n|------|------|--------|-------|\n${rows}`;

    // Aggregate stats
    const moodCounts = new Map<string, number>();
    const entityCounts = new Map<string, number>();
    let totalOpen = 0, totalDone = 0;
    let energySum = 0, energyN = 0;
    for (const e of entries) {
      if (e.mood) moodCounts.set(e.mood, (moodCounts.get(e.mood) || 0) + 1);
      for (const en of e.entities) entityCounts.set(en, (entityCounts.get(en) || 0) + 1);
      totalOpen += e.tasks.open;
      totalDone += e.tasks.done;
      if (e.energy > 0) { energySum += e.energy; energyN++; }
    }
    const topMoods = [...moodCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([m, c]) => `${moodToEmoji(m)} ${m}×${c}`).join(' · ');
    const topEntities = [...entityCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([n, c]) => `[[${n}]] (${c})`).join(' · ');
    const avgE = energyN > 0 ? (energySum / energyN).toFixed(1) : '—';

    const stats = [
      '## At a Glance',
      `- 📊 ${entries.length} entries · avg energy ${avgE}/10`,
      topMoods ? `- Top moods: ${topMoods}` : '',
      topEntities ? `- People/places/projects: ${topEntities}` : '',
      (totalOpen + totalDone) > 0 ? `- Tasks: ✅ ${totalDone} done · ⏳ ${totalOpen} open` : '',
    ].filter(Boolean).join('\n');

    const dataBlock = entries.map(e =>
      `${e.date} | mood:${e.mood} | energy:${e.energy} | entities:${e.entities.slice(0, 4).join(',')} | ${e.desc}`
    ).join('\n');

    const weekLabel = `${fmtDate(start)} — ${fmtDate(end)}`;
    const summary = await this.plugin.aiRouter.chat(WEEKLY_REPORT_SYSTEM_PROMPT, [
      { role: 'user', content: `Weekly diary data (${weekLabel}):\n${dataBlock}` }
    ]);

    return [
      `# Weekly Insights — ${weekLabel}`,
      '',
      stats,
      '',
      table,
      '',
      summary,
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
