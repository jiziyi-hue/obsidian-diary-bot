import { parseYaml } from 'obsidian';
import { splitSummaryMarkers } from './markdownUtils';

export interface ParsedSummary {
  frontmatter: {
    mood?: string;
    energy?: number;
    people?: string[];
    places?: string[];
    projects?: string[];
    topics?: string[];
    [k: string]: any;
  };
  body: string;
}

/**
 * Parse the structured AI summary output. Defensive: missing markers fall
 * back to treating the whole string as `body` with empty frontmatter.
 */
export function parseStructuredSummary(raw: string): ParsedSummary {
  if (!raw || typeof raw !== 'string') return { frontmatter: {}, body: '' };

  const split = splitSummaryMarkers(raw);
  if (!split.ok) return { frontmatter: {}, body: split.body };

  let frontmatter: Record<string, any> = {};
  try {
    const parsed = parseYaml(split.fmText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, any>;
    }
  } catch (e) {
    console.error('Diary Bot: failed to parse summary frontmatter', e);
  }
  return { frontmatter, body: split.body };
}
