import { App, TFile, normalizePath, stringifyYaml } from 'obsidian';
import DiaryBotPlugin from '../main';
import { wrapEntities, mergeIntoFrontmatter } from '../utils/markdownUtils';
import { fmtDate } from '../utils/dateUtils';

export interface StructuredAppend {
  frontmatter: Record<string, any>;
  body: string;
  /** Bare entity names to wrap as [[wikilinks]] within `body`. */
  entities: string[];
}

export class NoteWriter {
  private app: App;
  private plugin: DiaryBotPlugin;

  constructor(app: App, plugin: DiaryBotPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  public async ensureFolderExists(folderPath: string): Promise<void> {
    const normalizedPath = normalizePath(folderPath);
    if (normalizedPath === '' || normalizedPath === '/') return;
    const parts = normalizedPath.split('/');
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath === '' ? part : `${currentPath}/${part}`;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch {
          // race
        }
      }
    }
  }

  public getDailyNotePath(): string {
    const folder = this.plugin.settings.diaryFolder || 'Journal';
    return diaryPath(folder, fmtDate(new Date()));
  }

  /**
   * Structured append: merges frontmatter into the daily note's YAML via
   * Obsidian's atomic processFrontMatter API, rewrites bare entity mentions in
   * the body to [[wikilinks]], then appends the body.
   */
  async appendStructured(input: StructuredAppend): Promise<void> {
    const notePath = this.getDailyNotePath();
    const parentDir = notePath.substring(0, notePath.lastIndexOf('/'));
    await this.ensureFolderExists(parentDir);
    const wrappedBody = wrapEntities(input.body, input.entities);

    let file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      const initialFm = stringifyYaml({ date: today(), tags: ['diary'] }).trimEnd();
      const initial = `---\n${initialFm}\n---\n\n# ${today()}\n\n`;
      file = await this.app.vault.create(notePath, initial);
    }

    await this.app.fileManager.processFrontMatter(file as TFile, (fm) => {
      mergeIntoFrontmatter(fm, input.frontmatter, today());
    });

    if (this.plugin.settings.appendMode) {
      await this.app.vault.process(file as TFile, (data) => {
        return data.replace(/\s*$/, '') + '\n\n' + wrappedBody + '\n';
      });
    } else {
      // Replace everything after the frontmatter with the new body.
      await this.app.vault.process(file as TFile, (data) => {
        const fmMatch = data.match(/^---\n[\s\S]*?\n---\n?/);
        const head = fmMatch ? data.slice(0, fmMatch[0].length) : '';
        return head + '\n' + wrappedBody + '\n';
      });
    }
  }

  /** Plain append (used by daily/weekly reports). */
  async appendToDaily(content: string): Promise<void> {
    const notePath = this.getDailyNotePath();
    const parentDir = notePath.substring(0, notePath.lastIndexOf('/'));
    await this.ensureFolderExists(parentDir);
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof TFile) {
      if (this.plugin.settings.appendMode) {
        await this.app.vault.append(file, `\n\n${content}`);
      } else {
        await this.app.vault.modify(file, content);
      }
    } else {
      const initialFm = stringifyYaml({ date: today(), tags: ['diary'] }).trimEnd();
      const initial = `---\n${initialFm}\n---\n\n# ${today()}\n\n${content}\n`;
      await this.app.vault.create(notePath, initial);
    }
  }

  async getDailyContent(): Promise<string> {
    const notePath = this.getDailyNotePath();
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof TFile) return await this.app.vault.cachedRead(file);
    return '';
  }
}

// ── helpers ──

function today(): string {
  return fmtDate(new Date());
}

/** Returns nested diary path: Journal/2026/04/2026-04-30.md */
export function diaryPath(folder: string, dateStr: string): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return normalizePath(`${folder}/${dateStr}.md`);
  return normalizePath(`${folder}/${m[1]}/${m[2]}/${dateStr}.md`);
}
