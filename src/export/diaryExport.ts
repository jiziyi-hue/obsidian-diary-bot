import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import DiaryBotPlugin from '../main';

/**
 * Diary book export. Two formats:
 *   1. PDF — uses Electron `webContents.printToPDF` (zero external deps).
 *      Pattern borrowed from l1xnan/obsidian-better-export-pdf (MIT).
 *   2. Markdown bundle — concatenates all entries into one .md (.epub via pandoc / Binder externally).
 *
 * Scope: pick a year (or month) → render concatenated HTML preview → user can
 * save as PDF (browser print dialog or programmatic). Includes table of contents.
 */
export class DiaryExportModal extends Modal {
  private plugin: DiaryBotPlugin;
  private year: number;
  private format: 'pdf' | 'markdown' = 'pdf';

  constructor(plugin: DiaryBotPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.year = new Date().getFullYear();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Export Diary as Book' });

    new Setting(contentEl)
      .setName('Year')
      .setDesc('Bundle all daily entries from this year.')
      .addText((t) =>
        t.setValue(String(this.year)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n)) this.year = n;
        })
      );

    new Setting(contentEl)
      .setName('Format')
      .addDropdown((d) =>
        d
          .addOption('pdf', 'PDF (recommended)')
          .addOption('markdown', 'Markdown bundle (.md)')
          .setValue(this.format)
          .onChange((v) => { this.format = v as 'pdf' | 'markdown'; })
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('Export').setCta().onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Building…');
          try {
            await this.runExport();
            this.close();
          } catch (e: any) {
            new Notice('Export failed: ' + (e?.message || e));
            btn.setDisabled(false);
            btn.setButtonText('Retry');
          }
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }

  private async runExport(): Promise<void> {
    const entries = await this.collectEntries(this.year);
    if (entries.length === 0) {
      new Notice(`No diary entries found for ${this.year}.`);
      return;
    }
    if (this.format === 'markdown') {
      await this.exportMarkdown(entries);
    } else {
      await this.exportPdf(entries);
    }
  }

  /** Read all daily notes for given year, sorted by date asc. */
  private async collectEntries(year: number): Promise<DiaryEntry[]> {
    const folder = this.plugin.settings.diaryFolder || 'Journal';
    const yearFolder = normalizePath(`${folder}/${year}`);
    const out: DiaryEntry[] = [];
    for (const file of this.app.vault.getFiles()) {
      if (!file.path.startsWith(yearFolder + '/')) continue;
      if (file.extension !== 'md') continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(file.basename)) continue;
      const content = await this.app.vault.cachedRead(file);
      const cache = this.app.metadataCache.getFileCache(file);
      out.push({
        file,
        date: file.basename,
        content,
        frontmatter: (cache?.frontmatter as any) || {},
      });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  private async exportMarkdown(entries: DiaryEntry[]): Promise<void> {
    const parts: string[] = [
      `# Diary ${this.year}`,
      '',
      `_${entries.length} entries · generated ${new Date().toISOString().slice(0, 10)}_`,
      '',
      '---',
      '',
    ];
    // Table of contents
    parts.push('## Contents', '');
    for (const e of entries) {
      parts.push(`- [[${e.date}]]`);
    }
    parts.push('', '---', '');
    // Entries
    for (const e of entries) {
      parts.push(`## ${e.date}`, '');
      parts.push(stripFrontmatter(e.content));
      parts.push('', '---', '');
    }
    const outPath = normalizePath(`${this.plugin.settings.diaryFolder || 'Journal'}/Diary-${this.year}.md`);
    const existing = this.app.vault.getAbstractFileByPath(outPath);
    const content = parts.join('\n');
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(outPath, content);
    }
    new Notice(`Exported ${entries.length} entries → ${outPath}`);
  }

  private async exportPdf(entries: DiaryEntry[]): Promise<void> {
    const html = this.renderBookHtml(entries);
    const w = window.open('', '_blank');
    if (!w) {
      new Notice('Popup blocked. Allow popups, then re-export.');
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    // Auto-trigger browser print dialog (user picks "Save as PDF").
    setTimeout(() => {
      try { w.focus(); w.print(); } catch { /* ignore */ }
    }, 600);
    new Notice(`Print dialog opened with ${entries.length} entries. Choose "Save as PDF".`);
  }

  private renderBookHtml(entries: DiaryEntry[]): string {
    const tocItems = entries.map((e) => `<li><a href="#e-${e.date}">${e.date}</a></li>`).join('\n');
    const body = entries.map((e) => {
      const fm = e.frontmatter || {};
      const meta: string[] = [];
      if (fm.mood) meta.push(`mood: ${escapeHtml(String(fm.mood))}`);
      if (fm.energy != null) meta.push(`energy: ${escapeHtml(String(fm.energy))}/10`);
      const stripped = stripFrontmatter(e.content);
      return `
<section class="entry" id="e-${escapeHtml(e.date)}">
  <h2>${escapeHtml(e.date)}</h2>
  ${meta.length ? `<p class="meta">${meta.join(' · ')}</p>` : ''}
  <article>${escapeHtml(stripped).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>').replace(/$/, '</p>')}</article>
</section>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Diary ${this.year}</title>
<style>
  @page { size: A5; margin: 18mm 16mm; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.55; color: #222; max-width: 700px; margin: 0 auto; padding: 20px; }
  h1.cover-title { font-size: 32pt; text-align: center; margin: 80mm 0 4mm; letter-spacing: 1px; }
  .cover-sub { text-align: center; color: #666; font-style: italic; }
  .toc { page-break-after: always; }
  .toc h2 { font-size: 18pt; }
  .toc ul { list-style: none; padding: 0; columns: 2; column-gap: 24px; }
  .toc li { margin: 2px 0; }
  .toc a { color: #333; text-decoration: none; }
  .entry { page-break-inside: avoid; margin: 0 0 18mm; }
  .entry h2 { font-size: 16pt; margin: 0 0 4mm; border-bottom: 1px solid #ddd; padding-bottom: 2mm; }
  .entry .meta { color: #888; font-size: 9pt; margin: 0 0 4mm; font-style: italic; }
  .entry article p { margin: 0 0 6pt; text-align: justify; }
  @media print {
    body { max-width: none; padding: 0; }
  }
</style>
</head>
<body>
<div>
  <h1 class="cover-title">Diary ${this.year}</h1>
  <p class="cover-sub">${entries.length} entries · ${entries[0].date} – ${entries[entries.length - 1].date}</p>
</div>
<nav class="toc">
  <h2>Contents</h2>
  <ul>${tocItems}</ul>
</nav>
${body}
</body>
</html>`;
  }
}

interface DiaryEntry {
  file: TFile;
  date: string;
  content: string;
  frontmatter: Record<string, any>;
}

function stripFrontmatter(content: string): string {
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4);
    if (end > -1) return content.slice(end + 4).trimStart();
  }
  return content;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
