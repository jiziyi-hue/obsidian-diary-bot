import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type DiaryBotPlugin from '../main';
import { diaryPath } from '../vault/noteWriter';
import { streakCount, fmtDate, pad } from '../utils/dateUtils';
import uPlot from 'uplot';

export const DASHBOARD_VIEW_TYPE = 'diary-bot-dashboard';

export class DashboardView extends ItemView {
  private plugin: DiaryBotPlugin;
  private uplot: uPlot | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DiaryBotPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  getDisplayText(): string { return 'Diary Dashboard'; }
  getIcon(): string { return 'bar-chart-3'; }

  async onOpen() { await this.render(); }
  async onClose() { this.uplot?.destroy(); this.uplot = null; }

  async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('diary-dashboard');

    const data = await collectData(this.plugin);

    // Title
    const header = container.createDiv({ cls: 'dd-header' });
    header.createEl('h2', { text: 'Diary Dashboard' });
    header.createEl('span', { cls: 'dd-subtitle', text: dayRangeLabel(data.days) });

    // Stat cards
    const cardRow = container.createDiv({ cls: 'dd-cards' });
    this.statCard(cardRow, `${data.totalEntries}`, 'Entries');
    this.statCard(cardRow, `${data.streak}d`, 'Streak');
    this.statCard(cardRow, data.avgMood, 'Avg Mood');
    this.statCard(cardRow, `${data.avgEnergy}/10`, 'Avg Energy');

    // Calendar heatmap (last 30 days mini)
    const calCard = container.createDiv({ cls: 'dd-card' });
    calCard.createEl('h4', { text: 'Writing Activity' });
    this.renderCalendar(calCard, data.calendar);

    // Month grid calendar (current month, click date → open daily note)
    const monthCard = container.createDiv({ cls: 'dd-card' });
    monthCard.createEl('h4', { text: 'This Month' });
    this.renderMonthGrid(monthCard, data.calendar);

    // Mood/Energy trend
    const trendCard = container.createDiv({ cls: 'dd-card' });
    trendCard.createEl('h4', { text: 'Mood & Energy · 14 Days' });
    this.renderTrend(trendCard, data.trend);

    // On This Day
    if (data.onThisDay.length) {
      const otdCard = container.createDiv({ cls: 'dd-card' });
      otdCard.createEl('h4', { text: 'On This Day' });
      for (const item of data.onThisDay.slice(0, 3)) {
        const row = otdCard.createDiv({ cls: 'dd-otd-row' });
        row.createEl('strong', { text: String(item.year) });
        row.createEl('span', { text: item.snippet.slice(0, 120) });
      }
    }

    // Entities
    if (data.people.length || data.places.length) {
      const entRow = container.createDiv({ cls: 'dd-entity-row' });
      if (data.people.length) {
        const col = entRow.createDiv({ cls: 'dd-card' });
        col.createEl('h4', { text: 'People' });
        for (const p of data.people) col.createDiv({ text: p });
      }
      if (data.places.length) {
        const col = entRow.createDiv({ cls: 'dd-card' });
        col.createEl('h4', { text: 'Places' });
        for (const p of data.places) col.createDiv({ text: p });
      }
    }
  }

  private statCard(parent: HTMLElement, value: string, label: string) {
    const el = parent.createDiv({ cls: 'dd-stat' });
    el.createDiv({ cls: 'dd-stat-val', text: value });
    el.createDiv({ cls: 'dd-stat-lbl', text: label });
  }

  private renderCalendar(parent: HTMLElement, data: CalendarData) {
    this.renderInlineYearHeatmap(parent, data.dates, data.today);
  }

  /** Month grid: 7-col day-of-week × N rows. Click date → open daily note if exists. */
  private renderMonthGrid(parent: HTMLElement, data: CalendarData) {
    const grid = parent.createDiv({ cls: 'dd-month' });
    const monthName = new Date(data.year, data.month, 1).toLocaleString('en', { month: 'long', year: 'numeric' });
    grid.createEl('div', { cls: 'dd-month-title', text: monthName });

    const dowRow = grid.createDiv({ cls: 'dd-month-dow' });
    for (const d of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
      dowRow.createEl('span', { text: d });
    }

    const cells = grid.createDiv({ cls: 'dd-month-cells' });
    // Lead = days from prev month (Sun-start grid)
    const firstDow = new Date(data.year, data.month, 1).getDay();
    for (let i = 0; i < firstDow; i++) cells.createDiv({ cls: 'dd-month-cell empty' });
    for (let day = 1; day <= data.days; day++) {
      const dateStr = `${data.year}-${pad(data.month + 1)}-${pad(day)}`;
      const count = data.dates[dateStr] || 0;
      const cell = cells.createDiv({ cls: 'dd-month-cell' + (count > 0 ? ' has-entry' : '') + (dateStr === data.today ? ' today' : '') });
      cell.createEl('span', { cls: 'dd-month-num', text: String(day) });
      if (count > 0) cell.createEl('span', { cls: 'dd-month-dot' });
      cell.title = `${dateStr}${count > 0 ? ` · ${count} entries` : ''}`;
      if (count > 0) {
        cell.onclick = async () => {
          const folder = this.plugin.settings.diaryFolder || 'Journal';
          const path = diaryPath(folder, dateStr);
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            await this.app.workspace.getLeaf(false).openFile(file);
          }
        };
      }
    }
  }

  /** Inline 30-day SVG heatmap, calendar-style: rows = weeks, cols = days-of-week. */
  private renderInlineYearHeatmap(parent: HTMLElement, dates: Record<string, number>, todayStr: string) {
    const today = new Date(todayStr + 'T12:00:00');
    // End at most-recent Saturday. Start 5 weeks earlier on Sunday.
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end);
    start.setDate(start.getDate() - (5 * 7 - 1));

    const cell = 22, gap = 4;
    const cols = 7, rows = 5;
    const padLeft = 28, padTop = 22;
    const w = padLeft + cols * (cell + gap);
    const h = padTop + rows * (cell + gap);
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'dd-yearmap');
    svg.style.width = '100%';
    svg.style.maxWidth = `${w * 1.3}px`;
    svg.style.height = `${h * 1.3}px`;

    // Day-of-week column headers (Sun-Sat)
    const dowLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    for (let c = 0; c < 7; c++) {
      const t = document.createElementNS(svgNs, 'text');
      t.setAttribute('x', String(padLeft + c * (cell + gap) + cell / 2));
      t.setAttribute('y', '14');
      t.setAttribute('font-size', '10');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('fill', 'currentColor');
      t.style.opacity = '0.5';
      t.textContent = dowLabels[c];
      svg.appendChild(t);
    }

    let weekRow = 0;
    let weekStartLabel = '';
    for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
      const dow = cur.getDay();
      const dateKey = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
      const count = dates[dateKey] || 0;
      const level = count >= 3 ? 4 : count === 2 ? 3 : count === 1 ? 2 : 0;

      // Row label = month/day of first cell in row
      if (dow === 0) {
        weekStartLabel = `${cur.getMonth() + 1}/${cur.getDate()}`;
        const t = document.createElementNS(svgNs, 'text');
        t.setAttribute('x', '0');
        t.setAttribute('y', String(padTop + weekRow * (cell + gap) + cell / 2 + 4));
        t.setAttribute('font-size', '9');
        t.setAttribute('fill', 'currentColor');
        t.style.opacity = '0.5';
        t.textContent = weekStartLabel;
        svg.appendChild(t);
      }

      const rect = document.createElementNS(svgNs, 'rect');
      rect.setAttribute('x', String(padLeft + dow * (cell + gap)));
      rect.setAttribute('y', String(padTop + weekRow * (cell + gap)));
      rect.setAttribute('width', String(cell));
      rect.setAttribute('height', String(cell));
      rect.setAttribute('rx', '4');
      rect.setAttribute('fill', heatColor(level));
      if (dateKey === todayStr) {
        rect.setAttribute('stroke', 'currentColor');
        rect.setAttribute('stroke-width', '1.5');
      }
      rect.setAttribute('aria-label', `${dateKey}: ${count} entries`);
      const title = document.createElementNS(svgNs, 'title');
      title.textContent = `${dateKey} · ${count} entr${count === 1 ? 'y' : 'ies'}`;
      rect.appendChild(title);
      svg.appendChild(rect);

      if (dow === 6) weekRow++;
    }

    parent.appendChild(svg);
  }

  private renderTrend(parent: HTMLElement, data: TrendData) {
    if (!data.dates.length) {
      parent.createDiv({ cls: 'dd-empty', text: 'No data yet. Start writing!' });
      return;
    }
    const chartEl = parent.createDiv({ cls: 'dd-chart' });
    this.uplot?.destroy();

    // Unix timestamps in seconds (fix 1970 bug)
    const xs = data.dates.map(s => new Date(s + 'T12:00:00').getTime() / 1000);
    const moodVals = data.moods.map(v => v || undefined);
    const energyVals = data.energies.map(v => v || undefined);

    const opts: uPlot.Options = {
      width: Math.max(chartEl.clientWidth - 16, 400),
      height: 180,
      cursor: { show: true, drag: { x: true, y: false } },
      select: { show: true, left: 0, width: 0, top: 0, height: 0 },
      legend: { show: true, live: false },
      axes: [
        {
          stroke: 'var(--text-muted)',
          grid: { show: false },
          ticks: { show: false },
        },
        {
          side: 3,
          stroke: 'var(--text-muted)',
          grid: { stroke: 'rgba(128,128,128,0.1)', width: 1 },
          size: 30,
        },
      ],
      series: [
        {
          label: 'Date',
        },
        {
          label: 'Mood',
          stroke: '#8b5cf6',
          width: 2.5,
          points: { show: true, size: 4 },
          fill: 'rgba(139,92,246,0.08)',
          scale: 'mood',
        },
        {
          label: 'Energy',
          stroke: '#22c55e',
          width: 2,
          dash: [6, 3],
          points: { show: false },
          scale: '%',
        },
      ],
      scales: {
        mood: { range: [1, 8] },
        '%': { auto: true },
      },
    };

    this.uplot = new uPlot(opts, [xs, moodVals, energyVals], chartEl);
  }
}

// ── Data types ──

interface CalendarData { year: number; month: number; days: number; lead: number; weeks: number; cols: number; dates: Record<string, number>; today: string; }
interface TrendData { dates: string[]; moods: number[]; energies: number[]; }

interface DashData {
  days: number;
  totalEntries: number; streak: number; avgMood: string; avgEnergy: string;
  calendar: CalendarData;
  trend: TrendData;
  onThisDay: Array<{ year: number; snippet: string }>;
  people: string[]; places: string[];
}

async function collectData(plugin: DiaryBotPlugin): Promise<DashData> {
  const folder = plugin.settings.diaryFolder || 'Journal';
  const today = new Date();
  const todayStr = fmtDate(today);
  const nowMonth = today.getMonth();
  const nowYear = today.getFullYear();
  const firstDay = new Date(nowYear, nowMonth, 1).getDay();
  const lead = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(nowYear, nowMonth + 1, 0).getDate();
  const weeks = Math.ceil((lead + daysInMonth) / 7);

  const calendarDates: Record<string, number> = {};
  const trendD: TrendData = { dates: [], moods: [], energies: [] };
  const onThisDay: Array<{ year: number; snippet: string }> = [];
  const peopleCount = new Map<string, number>();
  const placesCount = new Map<string, number>();

  let totalEntries = 0, totalWords = 0;
  let moodSum = 0, moodCount = 0, energySum = 0, energyCount = 0;
  const streak = streakCount(
    (dateStr) => plugin.app.vault.getAbstractFileByPath(diaryPath(folder, dateStr)) != null,
    today,
    365,
  );

  const files = plugin.app.vault.getFiles();
  const thisMonth = today.getMonth();
  const thisYear = today.getFullYear();

  for (const f of files) {
    if (!f.path.startsWith(folder + '/')) continue;
    if (f.extension !== 'md') continue;
    const m = f.basename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const [, y, mo, d] = m;
    const dateKey = `${y}-${mo}-${d}`;

    const text = await plugin.app.vault.cachedRead(f);
    const entryCount = Math.max(1, (text.match(/>\s*\[!diary\]/g) || []).length);
    totalEntries += entryCount;
    totalWords += text.split(/\s+/).length;

    // Calendar data — full 365-day year window (today back 365 days).
    const fileDateForCal = new Date(+y, +mo - 1, +d);
    const daysAgoForCal = Math.floor((today.getTime() - fileDateForCal.getTime()) / 86400000);
    if (daysAgoForCal >= 0 && daysAgoForCal < 365) {
      calendarDates[dateKey] = entryCount;
    }

    const cache = plugin.app.metadataCache.getFileCache(f);
    const fm = (cache?.frontmatter || {}) as any;

    // Trend (last 14 days)
    const fileDate = new Date(+y, +mo - 1, +d);
    const daysAgo = Math.floor((today.getTime() - fileDate.getTime()) / 86400000);
    if (daysAgo >= 0 && daysAgo < 14) {
      const ms = scoreMood(fm?.mood);
      trendD.dates.unshift(dateKey);
      trendD.moods.unshift(ms);
      trendD.energies.unshift(typeof fm?.energy === 'number' ? fm.energy : 0);
    }

    // Aggregates
    if (fm?.mood) {
      const ms = scoreMood(fm.mood);
      if (ms > 0) { moodSum += ms; moodCount++; }
    }
    if (typeof fm?.energy === 'number') { energySum += fm.energy; energyCount++; }

    // On This Day
    if (+mo === today.getMonth() + 1 && +d === today.getDate() && +y !== today.getFullYear()) {
      onThisDay.push({ year: +y, snippet: ((fm?.description as string) || text.slice(0, 200)).trim() });
    }

    // Entities
    for (const p of (Array.isArray(fm?.people) ? fm.people : [])) {
      const name = String(p).replace(/\[\[|\]\]/g, '');
      if (name) peopleCount.set(name, (peopleCount.get(name) || 0) + 1);
    }
    for (const pl of (Array.isArray(fm?.places) ? fm.places : [])) {
      const name = String(pl).replace(/\[\[|\]\]/g, '');
      if (name) placesCount.set(name, (placesCount.get(name) || 0) + 1);
    }
  }

  onThisDay.sort((a, b) => b.year - a.year);

  return {
    days: daysInMonth,
    totalEntries,
    streak,
    avgMood: moodCount > 0 ? (moodSum / moodCount).toFixed(1) : '—',
    avgEnergy: energyCount > 0 ? (energySum / energyCount).toFixed(1) : '—',
    calendar: { year: nowYear, month: nowMonth, days: daysInMonth, lead, weeks, cols: 7, dates: calendarDates, today: todayStr },
    trend: trendD,
    onThisDay,
    people: topN(peopleCount, 5),
    places: topN(placesCount, 5),
  };
}

function scoreMood(mood?: string): number {
  if (!mood) return 0;
  const s = mood.toLowerCase();
  if (s.includes('happy') || s.includes('excited') || s.includes('grateful')) return 8;
  if (s.includes('hopeful') || s.includes('calm') || s.includes('peaceful')) return 7;
  if (s.includes('contemplative') || s.includes('reflective')) return 6;
  if (s.includes('tired') || s.includes('anxious') || s.includes('worried')) return 4;
  if (s.includes('sad') || s.includes('frustrated') || s.includes('angry')) return 3;
  return 5;
}
function topN(m: Map<string, number>, n: number): string[] {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `[[${k}]] (${c})`);
}
function dayRangeLabel(days: number): string {
  const t = new Date();
  const start = new Date(t); start.setDate(start.getDate() - 13);
  return `${fmtDate(start)} — ${fmtDate(t)}`;
}

/** Heatmap color levels — GitHub-style (light) using CSS vars for theme adaptation. */
function heatColor(level: number): string {
  switch (level) {
    case 4: return '#216e39';
    case 3: return '#30a14e';
    case 2: return '#40c463';
    case 1: return '#9be9a8';
    default: return 'var(--background-modifier-border, #ebedf0)';
  }
}
