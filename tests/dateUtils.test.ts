import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  pad,
  fmtDate,
  dateNDaysAgo,
  getLastSunday,
  getWeekNumber,
  streakCount,
} from '../src/utils/dateUtils';

test('pad zero-pads to two digits', () => {
  assert.equal(pad(0), '00');
  assert.equal(pad(5), '05');
  assert.equal(pad(10), '10');
  assert.equal(pad(99), '99');
});

test('fmtDate produces YYYY-MM-DD', () => {
  assert.equal(fmtDate(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(fmtDate(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(fmtDate(new Date(2026, 3, 30)), '2026-04-30');
});

test('dateNDaysAgo subtracts calendar days correctly', () => {
  const ref = new Date(2026, 3, 30); // 2026-04-30
  assert.equal(dateNDaysAgo(0, ref), '2026-04-30');
  assert.equal(dateNDaysAgo(1, ref), '2026-04-29');
  assert.equal(dateNDaysAgo(30, ref), '2026-03-31');
});

test('getLastSunday returns same date when input is Sunday', () => {
  const sun = new Date(2026, 4, 3); // 2026-05-03 is Sunday
  assert.equal(sun.getDay(), 0);
  assert.equal(fmtDate(getLastSunday(sun)), '2026-05-03');
});

test('getLastSunday returns the prior Sunday for any other weekday', () => {
  const mon = new Date(2026, 4, 4); // Monday
  assert.equal(fmtDate(getLastSunday(mon)), '2026-05-03');
  const sat = new Date(2026, 4, 9); // Saturday
  assert.equal(fmtDate(getLastSunday(sat)), '2026-05-03');
});

test('getWeekNumber matches ISO 8601 known dates', () => {
  // 2026-01-04 is in W1 (Sunday).
  assert.equal(getWeekNumber(new Date(2026, 0, 4)), 1);
  // 2026-01-05 (Monday) — ISO W2
  assert.equal(getWeekNumber(new Date(2026, 0, 5)), 2);
  // 2024-12-30 (Monday) — start of ISO W1 of 2025
  assert.equal(getWeekNumber(new Date(2024, 11, 30)), 1);
});

test('streakCount returns 0 when today has no note', () => {
  const today = new Date(2026, 3, 30);
  assert.equal(streakCount(() => false, today), 0);
});

test('streakCount counts consecutive days starting at today', () => {
  const today = new Date(2026, 3, 30);
  const present = new Set(['2026-04-30', '2026-04-29', '2026-04-28']);
  assert.equal(streakCount((d) => present.has(d), today), 3);
});

test('streakCount stops on first gap', () => {
  const today = new Date(2026, 3, 30);
  const present = new Set(['2026-04-30', '2026-04-28']); // 04-29 missing
  assert.equal(streakCount((d) => present.has(d), today), 1);
});

test('streakCount caps at max iterations', () => {
  const today = new Date(2026, 3, 30);
  assert.equal(streakCount(() => true, today, 10), 10);
});
