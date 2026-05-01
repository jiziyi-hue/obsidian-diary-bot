import { ItemView, WorkspaceLeaf, TFile, normalizePath } from 'obsidian';
import type DiaryBotPlugin from '../main';

export const TIMELINE_VIEW_TYPE = 'diary-bot-timeline';

interface TimelineCard {
  file: TFile;
  date: string;
  mood: string;
  energy: number | null;
  excerpt: string;
  firstPhoto: TFile | null;
  topics: string[];
}

/**
 * Timeline view — chronological card stream of all diary entries.
 * Newest first. Each card shows date, mood, energy, first photo, narrative excerpt, topic chips.
 * Click → opens entry. Borrows note-gallery vault-event hookup for incremental update.
 */
export class TimelineView extends ItemView {
  private plugin: DiaryBotPlugin;
  private cards: TimelineCard[] = [];
  private indexBuilt = false;

  constructor(leaf: WorkspaceLeaf, plugin: DiaryBotPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return TIMELINE_VIEW_TYPE; }
  getDisplayText(): string { return 'Diary Timeline'; }
  getIcon(): string { return 'list'; }

  async onOpen() {
    this.registerEvent(this.app.vault.on('create', (f) => {
      if (f instanceof TFile && this.isDaily(f)) { this.indexBuilt = false; this.render(); }
    }));
    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (f instanceof TFile && this.isDaily(f)) { this.indexBuilt = false; this.render(); }
    }));
    this.registerEvent(this.app.vault.on('delete', (f) => {
      if (f instanceof TFile && this.isDaily(f)) {
        this.cards = this.cards.filter((c) => c.file.path !== f.path);
        this.render();
      }
    }));
    await this.render();
  }

  async onClose() {
    this.containerEl.children[1]?.empty();
  }

  private async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('diary-timeline');

    container.createEl('h2', { text: 'Timeline' });

    if (!this.indexBuilt) {
      container.createEl('p', { text: 'Loading…', cls: 'dt-loading' });
      this.cards = await this.buildIndex();
      this.indexBuilt = true;
      container.empty();
      container.addClass('diary-timeline');
      container.createEl('h2', { text: 'Timeline' });
    }

    if (this.cards.length === 0) {
      container.createEl('p', { text: 'No diary entries yet. Send messages to your bot to start.' });
      return;
    }

    container.createEl('p', { cls: 'dt-subtitle', text: `${this.cards.length} entries` });

    // Group by year + month
    const sections = new Map<string, TimelineCard[]>();
    for (const c of this.cards) {
      const key = c.date.slice(0, 7);
      (sections.get(key) || sections.set(key, []).get(key)!).push(c);
    }
    const sortedKeys = Array.from(sections.keys()).sort((a, b) => b.localeCompare(a));

    for (const key of sortedKeys) {
      const list = sections.get(key)!;
      const sec = container.createDiv({ cls: 'dt-section' });
      sec.createEl('h3', { text: formatYearMonth(key) });
      for (const card of list) {
        this.renderCard(sec, card);
      }
    }
  }

  private renderCard(parent: HTMLElement, card: TimelineCard) {
    const el = parent.createDiv({ cls: 'dt-card' });
    el.onclick = async () => {
      await this.app.workspace.getLeaf(false).openFile(card.file);
    };

    if (card.firstPhoto) {
      const thumb = el.createDiv({ cls: 'dt-thumb' });
      const img = thumb.createEl('img');
      img.src = this.app.vault.getResourcePath(card.firstPhoto);
      img.loading = 'lazy';
      img.alt = card.date;
    }

    const body = el.createDiv({ cls: 'dt-body' });
    const head = body.createDiv({ cls: 'dt-head' });
    head.createEl('span', { cls: 'dt-date', text: formatDate(card.date) });
    if (card.mood) {
      const moodEl = head.createEl('span', { cls: 'dt-mood', text: `${moodEmoji(card.mood)} ${card.mood}` });
      moodEl.title = `mood: ${card.mood}`;
    }
    if (card.energy != null) {
      head.createEl('span', { cls: 'dt-energy', text: `⚡ ${card.energy}/10` });
    }

    if (card.excerpt) {
      body.createDiv({ cls: 'dt-excerpt', text: card.excerpt });
    }

    if (card.topics.length > 0) {
      const tags = body.createDiv({ cls: 'dt-tags' });
      for (const t of card.topics.slice(0, 4)) {
        tags.createEl('span', { cls: 'dt-tag', text: `#${t}` });
      }
    }
  }

  private async buildIndex(): Promise<TimelineCard[]> {
    const folder = this.plugin.settings.diaryFolder || 'Journal';
    const out: TimelineCard[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(folder + '/')) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(file.basename)) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const fm = (cache?.frontmatter || {}) as any;
      const text = await this.app.vault.cachedRead(file);

      // First image embed
      let firstPhoto: TFile | null = null;
      const embeds = cache?.embeds || [];
      for (const e of embeds) {
        const dest = this.app.metadataCache.getFirstLinkpathDest(e.link, file.path);
        if (dest && isImageFile(dest)) {
          firstPhoto = dest;
          break;
        }
      }

      // Excerpt: first paragraph that's not a callout / table / heading.
      const excerpt = extractExcerpt(text);

      // Topics from inline #tags
      const topics: string[] = [];
      for (const t of (cache?.tags || [])) {
        const tag = t.tag.replace(/^#/, '');
        if (tag !== 'diary' && !tag.startsWith('emotion/') && !tag.startsWith('topic/') && !tag.startsWith('relation/')) {
          topics.push(tag);
        }
      }

      out.push({
        file,
        date: file.basename,
        mood: typeof fm.mood === 'string' ? fm.mood : '',
        energy: typeof fm.energy === 'number' ? fm.energy : null,
        excerpt,
        firstPhoto,
        topics,
      });
    }

    out.sort((a, b) => b.date.localeCompare(a.date));
    return out;
  }

  private isDaily(f: TFile): boolean {
    const folder = this.plugin.settings.diaryFolder || 'Journal';
    return f.path.startsWith(folder + '/') && /^\d{4}-\d{2}-\d{2}$/.test(f.basename);
  }
}

function isImageFile(f: TFile): boolean {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif'].includes(f.extension.toLowerCase());
}

function formatDate(d: string): string {
  const [y, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}`;
}

function formatYearMonth(key: string): string {
  const [y, m] = key.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m) - 1]} ${y}`;
}

function moodEmoji(mood: string): string {
  const s = mood.toLowerCase();
  if (s.includes('happy') || s.includes('joyful')) return '😊';
  if (s.includes('excited')) return '🎉';
  if (s.includes('hopeful')) return '🌱';
  if (s.includes('calm') || s.includes('peaceful')) return '😌';
  if (s.includes('grateful')) return '🙏';
  if (s.includes('contemplative') || s.includes('reflective')) return '🤔';
  if (s.includes('tired') || s.includes('exhausted')) return '😴';
  if (s.includes('anxious') || s.includes('worried')) return '😰';
  if (s.includes('sad') || s.includes('down')) return '😢';
  if (s.includes('angry') || s.includes('frustrated')) return '😤';
  return '💭';
}

function extractExcerpt(text: string): string {
  // Strip frontmatter
  let body = text;
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 4);
    if (end > -1) body = body.slice(end + 4);
  }
  // Strip image embeds, callouts, headings, blockquotes, html
  const lines = body.split('\n');
  const candidates: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('>')) continue;
    if (trimmed.startsWith('<')) continue;
    if (trimmed.startsWith('![')) continue;
    if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]')) continue;
    if (trimmed.startsWith('- ')) continue;
    if (/^\*[^*]+\*\*?$/.test(trimmed)) continue; // pure poetic line
    candidates.push(trimmed);
    if (candidates.join(' ').length > 200) break;
  }
  const joined = candidates.join(' ').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').replace(/\s+/g, ' ');
  return joined.length > 200 ? joined.slice(0, 200) + '…' : joined;
}
