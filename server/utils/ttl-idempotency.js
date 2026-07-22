export class TtlIdempotencyCache {
  constructor({ ttlMs, maxEntries, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  remember(key, metadata = {}) {
    if (!key) return false;
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && now - existing.receivedAt < this.ttlMs) return true;

    this.entries.set(key, { ...metadata, receivedAt: now });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return false;
  }

  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.receivedAt < cutoff) this.entries.delete(key);
    }
  }

  get size() {
    return this.entries.size;
  }
}
