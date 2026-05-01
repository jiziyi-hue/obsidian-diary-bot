import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  withTimeout,
  backoffMs,
  sleep,
  truncate,
  isRetryableStatus,
} from '../../utils/retryUtils';

/**
 * Wrapper around `requestUrl` with:
 * - Promise.race timeout (Obsidian's requestUrl has no abort signal)
 * - One retry on 429 / 5xx with backoff + jitter
 * - Single throw on 4xx (other) and on persistent failure
 */
export async function requestWithRetry(
  opts: RequestUrlParam,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<RequestUrlResponse> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await withTimeout(requestUrl({ ...opts, throw: false }), timeoutMs);
      if (res.status >= 200 && res.status < 300) return res;

      if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${truncate(res.text || '', 200)}`);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error('requestWithRetry: unknown failure');
}
