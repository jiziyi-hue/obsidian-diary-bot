/**
 * Pure retry/timeout helpers (no obsidian dep) used by requestWithRetry.
 */

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_RETRIES = 1;
export const BASE_BACKOFF_MS = 1_500;

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export function backoffMs(attempt: number, base: number = BASE_BACKOFF_MS): number {
  const jitter = Math.random() * 0.5 + 0.75; // 0.75x – 1.25x
  return Math.round(base * Math.pow(2, attempt) * jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** True if status code merits a retry (transient). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
