import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import type DiaryBotPlugin from '../main';

export const PEOPLE_GRAPH_VIEW_TYPE = 'diary-bot-people-graph';

interface GraphNode {
  id: number;
  name: string;
  type: string;
  mention_count: number;
  last_seen: string;
}
interface GraphEdge {
  a: number;
  b: number;
  weight: number;
}

/**
 * People Graph view — entity list sorted by mention count, with top
 * co-occurrence partners shown as chips. Pulls from worker /graph (D1-backed).
 *
 * v1: list-based for clarity + low bundle. Force-directed layout (Cytoscape.js)
 * is a future enhancement once dataset size warrants it.
 */
export class PeopleGraphView extends ItemView {
  private plugin: DiaryBotPlugin;
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private filterType: 'all' | 'person' | 'place' | 'project' = 'all';

  constructor(leaf: WorkspaceLeaf, plugin: DiaryBotPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return PEOPLE_GRAPH_VIEW_TYPE; }
  getDisplayText(): string { return 'Diary People Graph'; }
  getIcon(): string { return 'users'; }

  async onOpen() {
    await this.loadAndRender();
  }

  async onClose() {
    this.containerEl.children[1]?.empty();
  }

  private async loadAndRender() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('diary-people-graph');
    container.createEl('h2', { text: 'People · Places · Projects' });

    const userId = this.plugin.settings.relayUserId;
    if (!userId) {
      container.createEl('p', { text: 'Connect Telegram first (settings → Connect Telegram).' });
      return;
    }

    container.createEl('p', { text: 'Loading…', cls: 'dpg-loading' });
    const data = await this.plugin.relayClient.fetchEntityGraph(userId);
    this.nodes = data.nodes;
    this.edges = data.edges;

    container.empty();
    container.addClass('diary-people-graph');
    container.createEl('h2', { text: 'People · Places · Projects' });

    if (this.nodes.length === 0) {
      container.createEl('p', { text: 'No entities indexed yet. Send diary messages with names of people, places, or projects — they get indexed when you /done.' });
      const refresh = container.createEl('button', { text: 'Refresh' });
      refresh.onclick = () => this.loadAndRender();
      return;
    }

    this.renderFilters(container);
    container.createEl('p', { cls: 'dpg-subtitle', text: `${this.nodes.length} entities · ${this.edges.length} connections` });
    this.renderEntityList(container);
  }

  private renderFilters(parent: HTMLElement) {
    const row = parent.createDiv({ cls: 'dpg-filters' });
    const opts: Array<{ key: typeof this.filterType; label: string }> = [
      { key: 'all', label: 'All' },
      { key: 'person', label: 'People' },
      { key: 'place', label: 'Places' },
      { key: 'project', label: 'Projects' },
    ];
    for (const o of opts) {
      const btn = row.createEl('button', { text: o.label, cls: this.filterType === o.key ? 'dpg-filter active' : 'dpg-filter' });
      btn.onclick = () => {
        this.filterType = o.key;
        const list = parent.querySelector('.dpg-list');
        if (list) list.remove();
        // Re-render filter row buttons by toggling classes
        for (const b of Array.from(row.querySelectorAll('button'))) {
          b.classList.toggle('active', (b.textContent || '').toLowerCase() === o.label.toLowerCase());
        }
        this.renderEntityList(parent);
      };
    }
  }

  private renderEntityList(parent: HTMLElement) {
    const list = parent.createDiv({ cls: 'dpg-list' });
    const filtered = this.filterType === 'all' ? this.nodes : this.nodes.filter((n) => n.type === this.filterType);

    // Build adjacency for quick neighbor lookup
    const adj = new Map<number, Array<{ id: number; weight: number }>>();
    for (const e of this.edges) {
      (adj.get(e.a) || adj.set(e.a, []).get(e.a)!).push({ id: e.b, weight: e.weight });
      (adj.get(e.b) || adj.set(e.b, []).get(e.b)!).push({ id: e.a, weight: e.weight });
    }
    const nodeById = new Map(this.nodes.map((n) => [n.id, n]));

    for (const node of filtered) {
      const card = list.createDiv({ cls: 'dpg-card' });
      const head = card.createDiv({ cls: 'dpg-card-head' });
      const typeIcon = node.type === 'person' ? '👤' : node.type === 'place' ? '📍' : '📁';
      head.createEl('span', { cls: 'dpg-icon', text: typeIcon });
      head.createEl('span', { cls: 'dpg-name', text: node.name });
      head.createEl('span', { cls: 'dpg-meta', text: `${node.mention_count} mention${node.mention_count === 1 ? '' : 's'} · last ${node.last_seen}` });

      const neighbors = (adj.get(node.id) || [])
        .sort((x, y) => y.weight - x.weight)
        .slice(0, 6);
      if (neighbors.length > 0) {
        const chipRow = card.createDiv({ cls: 'dpg-chips' });
        chipRow.createEl('span', { cls: 'dpg-chips-label', text: 'with: ' });
        for (const n of neighbors) {
          const target = nodeById.get(n.id);
          if (!target) continue;
          const chip = chipRow.createEl('span', { cls: 'dpg-chip', text: `${target.name} (${n.weight})` });
          chip.title = `${target.name} appeared together ${n.weight} time${n.weight === 1 ? '' : 's'}`;
        }
      }
    }
  }
}
