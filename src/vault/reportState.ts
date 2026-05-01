import { App } from 'obsidian';

export interface ReportStateData {
  lastWeekly?: string;
  lastMonthly?: string;
}

/**
 * Persists report-generation state to its own file so weekly/monthly
 * generators don't round-trip through the plugin's settings JSON.
 */
export class ReportState {
  private app: App;
  private path: string;
  private cache: ReportStateData | null = null;

  constructor(app: App, pluginId: string) {
    this.app = app;
    this.path = `.obsidian/plugins/${pluginId}/report-state.json`;
  }

  async load(): Promise<ReportStateData> {
    if (this.cache) return this.cache;
    try {
      if (await this.app.vault.adapter.exists(this.path)) {
        const raw = await this.app.vault.adapter.read(this.path);
        const parsed = JSON.parse(raw);
        this.cache = parsed && typeof parsed === 'object' ? parsed : {};
      } else {
        this.cache = {};
      }
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  async update(patch: Partial<ReportStateData>): Promise<void> {
    const current = await this.load();
    this.cache = { ...current, ...patch };
    try {
      await this.app.vault.adapter.write(this.path, JSON.stringify(this.cache));
    } catch (e) {
      console.error('Diary Bot: failed to write report state', e);
    }
  }
}
