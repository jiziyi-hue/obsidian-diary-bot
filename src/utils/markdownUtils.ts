/**
 * Pure markdown helpers (no obsidian dep). Tested by tests/markdownUtils.test.ts.
 */

const FRONTMATTER_MARKER = /^-{3,}\s*FRONTMATTER\s*-{3,}\s*$/im;
const SUMMARY_MARKER = /^-{3,}\s*SUMMARY\s*-{3,}\s*$/im;

export interface MarkerSplit {
  fmText: string;
  body: string;
  ok: boolean;
}

/**
 * Splits AI summary output by `--- FRONTMATTER ---` / `--- SUMMARY ---` markers.
 * Returns ok=false if either marker is missing or out of order; in that case
 * `body` contains the whole input trimmed.
 */
export function splitSummaryMarkers(raw: string): MarkerSplit {
  if (!raw) return { fmText: '', body: '', ok: false };
  const fmMatch = raw.match(FRONTMATTER_MARKER);
  const smMatch = raw.match(SUMMARY_MARKER);
  if (!fmMatch || !smMatch || smMatch.index! <= fmMatch.index!) {
    return { fmText: '', body: raw.trim(), ok: false };
  }
  const fmStart = fmMatch.index! + fmMatch[0].length;
  const fmEnd = smMatch.index!;
  const smStart = smMatch.index! + smMatch[0].length;
  return {
    fmText: raw.slice(fmStart, fmEnd).trim(),
    body: raw.slice(smStart).trim(),
    ok: true,
  };
}

interface Segment { text: string; protected: boolean; }

function splitProtected(input: string): Segment[] {
  const segs: Segment[] = [];
  const re = /(```[\s\S]*?```|`[^`\n]*`|!\[\[[^\]]+\]\]|\[\[[^\]]+\]\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) segs.push({ text: input.slice(last, m.index), protected: false });
    segs.push({ text: m[0], protected: true });
    last = m.index + m[0].length;
  }
  if (last < input.length) segs.push({ text: input.slice(last), protected: false });
  return segs;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wrap bare entity names in `body` as [[Name]] wikilinks.
 * - Longest names matched first (avoid "John" matching inside "John Smith").
 * - Skip matches inside fenced code, inline code, and existing wikilinks/embeds.
 */
export function wrapEntities(body: string, entities: string[]): string {
  if (!body || !entities?.length) return body;
  const sorted = [...new Set(entities.filter((e) => e && e.trim()))]
    .map((e) => e.trim())
    .sort((a, b) => b.length - a.length);

  const segments = splitProtected(body);
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].protected) continue;
    let text = segments[i].text;
    for (const name of sorted) {
      const escaped = escapeRegex(name);
      // CJK has no whitespace word boundaries, so for CJK-containing names we
      // match anywhere (longest-first sort prevents partial overlap of related
      // names; existing [[wikilinks]]/embeds are handled by splitProtected).
      // Latin names use a Unicode-letter boundary to avoid mid-word matches.
      const re = isCjk(name)
        ? new RegExp(`(${escaped})`, 'gu')
        : new RegExp(`(^|[^\\p{L}\\p{N}_\\[])(${escaped})(?=$|[^\\p{L}\\p{N}_\\]])`, 'gu');
      text = isCjk(name)
        ? text.replace(re, (_m, hit) => `[[${hit}]]`)
        : text.replace(re, (_m, pre, hit) => `${pre}[[${hit}]]`);
    }
    segments[i].text = text;
  }
  return segments.map((s) => s.text).join('');
}

function isCjk(s: string): boolean {
  return /[㐀-鿿぀-ヿ가-힯]/.test(s);
}

/**
 * Merge `next` into `fm` in place. Arrays union (deduped, string-keyed),
 * scalars overwrite when truthy. Pre-fills `tags`/`date` defaults if absent.
 */
export function mergeIntoFrontmatter(
  fm: Record<string, any>,
  next: Record<string, any>,
  defaultDate: string
): void {
  if (fm.tags === undefined) fm.tags = ['diary'];
  if (fm.date === undefined) fm.date = defaultDate;

  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const existingArr = Array.isArray(fm[k])
        ? fm[k]
        : (fm[k] !== undefined && fm[k] !== '' ? [fm[k]] : []);
      const set = new Set([...existingArr.map(String), ...v.map(String)]);
      fm[k] = Array.from(set);
    } else if (typeof v === 'string' && v === '') {
      // skip empty string
    } else {
      fm[k] = v;
    }
  }
}
