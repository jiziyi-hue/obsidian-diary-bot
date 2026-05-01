import { ItemView, WorkspaceLeaf, TFile, normalizePath } from 'obsidian';
import type DiaryBotPlugin from '../main';

export const PHOTO_WALL_VIEW_TYPE = 'diary-bot-photo-wall';

interface PhotoEntry {
  file: TFile;
  parentNote: TFile | null;
  parentDate: string | null;
}

/**
 * Photo Wall — masonry-style gallery of all diary attachments.
 *
 * Index lifecycle:
 *   - Built lazily on first render
 *   - Subscribed to vault create/delete events for incremental update
 *   - Click image → opens parent diary entry
 *
 * Borrowed: pashashocky/obsidian-note-gallery vault-event hookup pattern.
 */
export class PhotoWallView extends ItemView {
  private plugin: DiaryBotPlugin;
  private index: PhotoEntry[] = [];
  private indexBuilt = false;

  constructor(leaf: WorkspaceLeaf, plugin: DiaryBotPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return PHOTO_WALL_VIEW_TYPE; }
  getDisplayText(): string { return 'Diary Photo Wall'; }
  getIcon(): string { return 'image'; }

  async onOpen() {
    this.registerEvent(
      this.app.vault.on('create', (f) => {
        if (f instanceof TFile && this.isAttachment(f)) {
          this.indexBuilt = false;
          this.render();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', (f) => {
        if (f instanceof TFile && this.isAttachment(f)) {
          this.index = this.index.filter((p) => p.file.path !== f.path);
          this.render();
        }
      })
    );
    await this.render();
  }

  async onClose() {
    this.containerEl.children[1]?.empty();
  }

  private async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('diary-photo-wall');

    container.createEl('h2', { text: 'Photo Wall' });

    if (!this.indexBuilt) {
      container.createEl('p', { text: 'Indexing…', cls: 'dpw-loading' });
      this.index = await this.buildIndex();
      this.indexBuilt = true;
      container.empty();
      container.addClass('diary-photo-wall');
      container.createEl('h2', { text: 'Photo Wall' });
    }

    if (this.index.length === 0) {
      container.createEl('p', { text: 'No photos yet. Send images via Telegram to populate the wall.' });
      return;
    }

    const subtitle = container.createEl('p', { cls: 'dpw-subtitle' });
    subtitle.setText(`${this.index.length} photo${this.index.length === 1 ? '' : 's'}`);

    // Group by month. Newest first.
    const byMonth = new Map<string, PhotoEntry[]>();
    for (const p of this.index) {
      const key = p.parentDate ? p.parentDate.slice(0, 7) : 'undated';
      (byMonth.get(key) || byMonth.set(key, []).get(key)!).push(p);
    }
    const sortedKeys = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));

    for (const month of sortedKeys) {
      const photos = byMonth.get(month)!;
      const section = container.createDiv({ cls: 'dpw-section' });
      section.createEl('h3', { text: month === 'undated' ? 'Undated' : month });
      const grid = section.createDiv({ cls: 'dpw-grid' });
      for (const p of photos) {
        this.renderTile(grid, p);
      }
    }
  }

  private renderTile(parent: HTMLElement, photo: PhotoEntry) {
    const tile = parent.createDiv({ cls: 'dpw-tile' });
    const img = tile.createEl('img');
    img.src = this.app.vault.getResourcePath(photo.file);
    img.loading = 'lazy';
    img.alt = photo.file.basename;
    if (photo.parentDate) {
      tile.createEl('span', { cls: 'dpw-tile-date', text: photo.parentDate });
    }
    tile.onclick = async () => {
      if (photo.parentNote) {
        await this.app.workspace.getLeaf(false).openFile(photo.parentNote);
      } else {
        await this.app.workspace.getLeaf(false).openFile(photo.file);
      }
    };
  }

  private async buildIndex(): Promise<PhotoEntry[]> {
    const folder = this.plugin.settings.diaryFolder || 'Journal';
    const attachmentFolder = normalizePath(`${folder}/Attachments`);
    const out: PhotoEntry[] = [];

    // Pre-build date-note → wikilink references map (which note links to which IMG)
    const refMap = new Map<string, TFile>(); // attachment path → parent note
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(folder + '/')) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(file.basename)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const links = cache?.embeds || [];
      for (const link of links) {
        const target = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
        if (target && !refMap.has(target.path)) {
          refMap.set(target.path, file);
        }
      }
    }

    for (const file of this.app.vault.getFiles()) {
      if (!file.path.startsWith(attachmentFolder)) continue;
      if (!isImageExtension(file.extension)) continue;
      const parent = refMap.get(file.path) || null;
      out.push({
        file,
        parentNote: parent,
        parentDate: parent ? parent.basename : null,
      });
    }

    // Newest first by parent date desc, then by filename desc as tiebreaker.
    out.sort((a, b) => {
      const ad = a.parentDate || '';
      const bd = b.parentDate || '';
      if (ad !== bd) return bd.localeCompare(ad);
      return b.file.basename.localeCompare(a.file.basename);
    });
    return out;
  }

  private isAttachment(f: TFile): boolean {
    const folder = this.plugin.settings.diaryFolder || 'Journal';
    return f.path.startsWith(`${folder}/Attachments/`) && isImageExtension(f.extension);
  }
}

function isImageExtension(ext: string): boolean {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif'].includes(ext.toLowerCase());
}
