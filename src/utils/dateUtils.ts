/**
 * Pure date helpers shared across vault/dashboard/messageHandler.
 * Must not import from 'obsidian' so unit tests can exercise them in plain Node.
 */

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dateNDaysAgo(n: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return fmtDate(d);
}

/** Most recent Sunday (returns the date itself if Sunday). */
export function getLastSunday(today: Date): Date {
  const d = new Date(today);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/** ISO-like week number: week 1 = the week containing Jan 4. */
export function getWeekNumber(d: Date): number {
  const target = new Date(d.getTime());
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7)); // nearest Thursday
  const week1 = new Date(target.getFullYear(), 0, 4);
  return 1 + Math.round(((target.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

/**
 * Counts the longest unbroken streak of consecutive days (ending at `today`)
 * for which `hasNote(dateStr)` returns true. Caps at `max` iterations.
 */
export function streakCount(
  hasNote: (dateStr: string) => boolean,
  today: Date,
  max: number = 365
): number {
  const d = new Date(today);
  let streak = 0;
  for (let i = 0; i < max; i++) {
    if (i > 0) d.setDate(d.getDate() - 1);
    if (hasNote(fmtDate(d))) streak++;
    else break;
  }
  return streak;
}
