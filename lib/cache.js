'use strict';

/**
 * 进程内 TTL 缓存。过期后重新拉取；上游失败时回退到上一次成功结果，
 * 保证页面在数据源短暂抖动时仍可用。
 */
class TtlCache {
  constructor() {
    this.store = new Map();
    this.pending = new Map();
  }

  async get(key, ttlMs, producer) {
    const hit = this.store.get(key);
    const now = Date.now();
    if (hit && now - hit.time < ttlMs) return hit.value;

    if (this.pending.has(key)) return this.pending.get(key);

    const task = (async () => {
      try {
        const value = await producer();
        this.store.set(key, { value, time: Date.now() });
        return value;
      } catch (err) {
        if (hit) return hit.value;
        throw err;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, task);
    return task;
  }

  peek(key) {
    const hit = this.store.get(key);
    return hit ? hit.value : null;
  }
}

module.exports = { TtlCache };
