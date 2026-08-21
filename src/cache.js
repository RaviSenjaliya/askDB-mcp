import { config } from './config.js';

/**
 * Tiny in-process TTL cache for Pinecone round trips. Promises are cached, not
 * values, so two concurrent calls for the same key share one network request.
 *
 * Over stdio the process is long-lived, so this is a real hit rate. Hosted, a
 * warm Vercel container is reused across invocations, so repeat questions in
 * the same conversation skip Pinecone entirely.
 */
const store = new Map();
const MAX_ENTRIES = 300;

/** Rejections are evicted immediately — never cache a failure. */
export function cached(key, produce, ttlMs = config.cacheTtlMs) {
  if (ttlMs <= 0) return Promise.resolve().then(produce);

  const now = Date.now();
  const entry = store.get(key);
  if (entry && entry.expires > now) return entry.value;

  const value = Promise.resolve()
    .then(produce)
    .catch((error) => {
      store.delete(key);
      throw error;
    });
  store.set(key, { value, expires: now + ttlMs });

  if (store.size > MAX_ENTRIES) {
    for (const [entryKey, held] of store) {
      if (held.expires <= now) store.delete(entryKey);
    }
    // Still oversized: drop the oldest insertions (Map keeps insertion order).
    for (const entryKey of store.keys()) {
      if (store.size <= MAX_ENTRIES) break;
      store.delete(entryKey);
    }
  }

  return value;
}

export const clearCache = () => store.clear();
