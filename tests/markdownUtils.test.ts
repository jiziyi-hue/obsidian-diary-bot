import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  splitSummaryMarkers,
  wrapEntities,
  mergeIntoFrontmatter,
} from '../src/utils/markdownUtils';

// ── splitSummaryMarkers ──

test('splitSummaryMarkers splits well-formed input', () => {
  const raw =
    `--- FRONTMATTER ---\nmood: happy\nenergy: 7\n--- SUMMARY ---\nBody here.`;
  const r = splitSummaryMarkers(raw);
  assert.equal(r.ok, true);
  assert.equal(r.fmText, 'mood: happy\nenergy: 7');
  assert.equal(r.body, 'Body here.');
});

test('splitSummaryMarkers returns ok=false when markers missing', () => {
  const r = splitSummaryMarkers('just plain text');
  assert.equal(r.ok, false);
  assert.equal(r.body, 'just plain text');
});

test('splitSummaryMarkers returns ok=false when SUMMARY before FRONTMATTER', () => {
  const raw = `--- SUMMARY ---\nx\n--- FRONTMATTER ---\ny`;
  const r = splitSummaryMarkers(raw);
  assert.equal(r.ok, false);
});

test('splitSummaryMarkers tolerates extra dashes around marker words', () => {
  const raw = `------- FRONTMATTER -------\nmood: calm\n------- SUMMARY -------\nbody`;
  const r = splitSummaryMarkers(raw);
  assert.equal(r.ok, true);
  assert.equal(r.fmText, 'mood: calm');
  assert.equal(r.body, 'body');
});

// ── wrapEntities ──

test('wrapEntities wraps plain entity occurrences', () => {
  const out = wrapEntities('I met Alex at Central Park.', ['Alex', 'Central Park']);
  assert.equal(out, 'I met [[Alex]] at [[Central Park]].');
});

test('wrapEntities skips already-wrapped names', () => {
  const out = wrapEntities('Already [[Alex]] linked.', ['Alex']);
  assert.equal(out, 'Already [[Alex]] linked.');
});

test('wrapEntities skips inside fenced code', () => {
  const md = '```\nAlex inside code\n```\nAlex outside';
  const out = wrapEntities(md, ['Alex']);
  assert.equal(out, '```\nAlex inside code\n```\n[[Alex]] outside');
});

test('wrapEntities skips inline code', () => {
  const out = wrapEntities('use `Alex.run()` then call Alex', ['Alex']);
  assert.equal(out, 'use `Alex.run()` then call [[Alex]]');
});

test('wrapEntities prefers longer name over shorter substring', () => {
  const out = wrapEntities('John Smith met John', ['John', 'John Smith']);
  // John Smith wraps first because longer; bare "John" then wraps the second occurrence
  assert.equal(out, '[[John Smith]] met [[John]]');
});

test('wrapEntities handles CJK names without word boundaries', () => {
  const out = wrapEntities('今天和小明一起吃饭。', ['小明']);
  assert.equal(out, '今天和[[小明]]一起吃饭。');
});

test('wrapEntities returns input unchanged when no entities', () => {
  assert.equal(wrapEntities('hello world', []), 'hello world');
  assert.equal(wrapEntities('', ['Alex']), '');
});

test('wrapEntities skips embeds (![[...]])', () => {
  const out = wrapEntities('photo ![[IMG_Alex.jpg]] with Alex', ['Alex']);
  assert.equal(out, 'photo ![[IMG_Alex.jpg]] with [[Alex]]');
});

// ── mergeIntoFrontmatter ──

test('mergeIntoFrontmatter unions arrays and dedupes', () => {
  const fm: Record<string, any> = { people: ['Alex'] };
  mergeIntoFrontmatter(fm, { people: ['Alex', 'Bob'] }, '2026-04-30');
  assert.deepEqual(fm.people, ['Alex', 'Bob']);
});

test('mergeIntoFrontmatter overwrites scalars when truthy', () => {
  const fm: Record<string, any> = { mood: 'tired', energy: 3 };
  mergeIntoFrontmatter(fm, { mood: 'calm', energy: 7 }, '2026-04-30');
  assert.equal(fm.mood, 'calm');
  assert.equal(fm.energy, 7);
});

test('mergeIntoFrontmatter skips empty strings', () => {
  const fm: Record<string, any> = { mood: 'tired' };
  mergeIntoFrontmatter(fm, { mood: '' }, '2026-04-30');
  assert.equal(fm.mood, 'tired');
});

test('mergeIntoFrontmatter skips undefined / null', () => {
  const fm: Record<string, any> = { mood: 'tired' };
  mergeIntoFrontmatter(fm, { mood: undefined, energy: null }, '2026-04-30');
  assert.equal(fm.mood, 'tired');
  assert.equal(fm.energy, undefined);
});

test('mergeIntoFrontmatter pre-fills tags + date when missing', () => {
  const fm: Record<string, any> = {};
  mergeIntoFrontmatter(fm, { mood: 'happy' }, '2026-04-30');
  assert.deepEqual(fm.tags, ['diary']);
  assert.equal(fm.date, '2026-04-30');
});

test('mergeIntoFrontmatter does not overwrite existing tags/date', () => {
  const fm: Record<string, any> = { tags: ['custom'], date: '2025-01-01' };
  mergeIntoFrontmatter(fm, { mood: 'happy' }, '2026-04-30');
  assert.deepEqual(fm.tags, ['custom']);
  assert.equal(fm.date, '2025-01-01');
});

test('mergeIntoFrontmatter promotes existing scalar to array on union', () => {
  const fm: Record<string, any> = { people: 'Alex' };
  mergeIntoFrontmatter(fm, { people: ['Bob'] }, '2026-04-30');
  assert.deepEqual(fm.people, ['Alex', 'Bob']);
});
