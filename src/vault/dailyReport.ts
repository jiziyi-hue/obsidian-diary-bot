import { TFile, normalizePath } from 'obsidian';
import DiaryBotPlugin from '../main';
import { DAILY_REVIEW_PROMPT } from '../ai/prompts';
import { diaryPath } from './noteWriter';

export class DailyReportGenerator {
  private plugin: DiaryBotPlugin;

  constructor(plugin: DiaryBotPlugin) {
    this.plugin = plugin;
  }

  /** Check if daily review is due and prepend to today's note. */
  async checkAndPrepend(): Promise<void> {
    const folder = this.plugin.settings.diaryFolder || 'Journal';
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const path = diaryPath(folder, dateStr);

    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    // Check if already generated
    const existing = await this.plugin.app.vault.read(file);
    if (existing.includes('## 🌙 Daily Review')) return;

    // Check if it's time (past 21:00 or past midnight and not yet done)
    const reportTime = this.plugin.settings.dailyReportTime || '21:00';
    const [rh, rm] = reportTime.split(':').map(Number);
    const reportMin = rh * 60 + rm;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < reportMin) return; // not yet time

    await this.generate(dateStr, file, existing);
  }

  /** Catch-up: generate for a specific past date. */
  async generateForDate(dateStr: string): Promise<void> {
    const folder = this.plugin.settings.diaryFolder || 'Journal';
    const path = diaryPath(folder, dateStr);
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const existing = await this.plugin.app.vault.read(file);
    if (existing.includes('## 🌙 Daily Review')) return;
    await this.generate(dateStr, file, existing);
  }

  private async generate(dateStr: string, file: TFile, existingContent: string): Promise<void> {
    try {
      const diaryEntries = existingContent.match(/> \[!diary\][\s\S]*?(?=> \[!diary\]|$)/g) || [];
      if (diaryEntries.length === 0) return;

      const summaries = diaryEntries.map(e => e.replace(/> \[!quote\][\s\S]*/g, '').slice(0, 300)).join('\n\n');
      const review = await this.plugin.aiRouter.chat(DAILY_REVIEW_PROMPT, [
        { role: 'user', content: `Today's diary entries:\n${summaries}` }
      ]);

      // Prepend review after frontmatter
      const fmMatch = existingContent.match(/^---\n[\s\S]*?\n---\n?/);
      const newContent = fmMatch
        ? existingContent.slice(0, fmMatch[0].length) + '\n' + review + '\n\n---\n\n' + existingContent.slice(fmMatch[0].length)
        : review + '\n\n---\n\n' + existingContent;

      await this.plugin.app.vault.modify(file, newContent);
      console.log(`Diary Bot: daily review generated for ${dateStr}`);
    } catch (e) {
      console.error('Diary Bot: daily review failed', e);
    }
  }
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
