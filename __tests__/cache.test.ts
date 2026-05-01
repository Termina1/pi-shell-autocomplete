import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cache, LruCache } from "../cache";

describe("Cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic operations", () => {
    it("sets and gets a value", () => {
      const cache = new Cache<string, number>(1000);
      cache.set("a", 1);
      expect(cache.get("a")).toBe(1);
    });

    it("returns undefined for missing key", () => {
      const cache = new Cache<string, number>(1000);
      expect(cache.get("missing")).toBeUndefined();
    });

    it("has() returns true for cached value", () => {
      const cache = new Cache<string, number>(1000);
      cache.set("a", 1);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
    });

    it("delete removes a key", () => {
      const cache = new Cache<string, number>(1000);
      cache.set("a", 1);
      cache.delete("a");
      expect(cache.get("a")).toBeUndefined();
    });

    it("clear removes all entries", () => {
      const cache = new Cache<string, number>(1000);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it("size returns entry count", () => {
      const cache = new Cache<string, number>(1000);
      expect(cache.size).toBe(0);
      cache.set("a", 1);
      expect(cache.size).toBe(1);
    });
  });

  describe("TTL expiry", () => {
    it("returns value before TTL expires", () => {
      const cache = new Cache<string, number>(5000);
      cache.set("a", 1);
      vi.advanceTimersByTime(4000);
      expect(cache.get("a")).toBe(1);
    });

    it("returns undefined after TTL expires", () => {
      const cache = new Cache<string, number>(5000);
      cache.set("a", 1);
      vi.advanceTimersByTime(5001);
      expect(cache.get("a")).toBeUndefined();
    });

    it("has returns false after TTL expires", () => {
      const cache = new Cache<string, number>(5000);
      cache.set("a", 1);
      vi.advanceTimersByTime(5001);
      expect(cache.has("a")).toBe(false);
    });
  });

  describe("getOrLoad with stampede prevention", () => {
    it("loads and caches value on first call", async () => {
      const cache = new Cache<string, number>(5000);
      const loader = vi.fn().mockResolvedValue(42);

      const result = await cache.getOrLoad("key", loader);
      expect(result).toBe(42);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("returns cached value without calling loader", async () => {
      const cache = new Cache<string, number>(5000);
      cache.set("key", 99);
      const loader = vi.fn().mockResolvedValue(42);

      const result = await cache.getOrLoad("key", loader);
      expect(result).toBe(99);
      expect(loader).not.toHaveBeenCalled();
    });

    it("deduplicates concurrent loads for same key", async () => {
      const cache = new Cache<string, number>(5000);
      let callCount = 0;
      const loader = async () => {
        callCount++;
        // Use a promise that resolves on next microtick (works with fake timers)
        await Promise.resolve();
        return 42;
      };

      const [r1, r2, r3] = await Promise.all([
        cache.getOrLoad("key", loader),
        cache.getOrLoad("key", loader),
        cache.getOrLoad("key", loader),
      ]);

      expect(r1).toBe(42);
      expect(r2).toBe(42);
      expect(r3).toBe(42);
      expect(callCount).toBe(1);
    });

    it("does not deduplicate different keys", async () => {
      const cache = new Cache<string, number>(5000);
      let callCount = 0;
      const loader = async () => {
        const result = ++callCount;
        return result;
      };

      const [r1, r2] = await Promise.all([
        cache.getOrLoad("a", loader),
        cache.getOrLoad("b", loader),
      ]);

      expect(r1).not.toBe(r2);
      expect(callCount).toBe(2);
    });
  });

  describe("getStaleWhileRevalidate", () => {
    it("returns stale value and triggers refresh", async () => {
      const cache = new Cache<string, number>(100);
      cache.set("key", 1);

      // Time passes past TTL
      vi.advanceTimersByTime(200);

      const loader = vi.fn().mockResolvedValue(2);
      const stale = cache.getStaleWhileRevalidate("key", loader);

      // Returns stale value (1), not undefined
      expect(stale).toBe(1);
      // Loader was called for background refresh
      expect(loader).toHaveBeenCalled();
    });

    it("returns undefined for never-cached key and triggers load", () => {
      const cache = new Cache<string, number>(100);
      const loader = vi.fn().mockResolvedValue(2);

      const result = cache.getStaleWhileRevalidate("key", loader);
      expect(result).toBeUndefined();
      expect(loader).toHaveBeenCalled();
    });
  });
});

describe("LruCache", () => {
  describe("basic operations", () => {
    it("sets and gets a value", () => {
      const cache = new LruCache<string, number>(10);
      cache.set("a", 1);
      expect(cache.get("a")).toBe(1);
    });

    it("returns undefined for missing key", () => {
      const cache = new LruCache<string, number>(10);
      expect(cache.get("missing")).toBeUndefined();
    });

    it("has returns correct value", () => {
      const cache = new LruCache<string, number>(10);
      cache.set("a", 1);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entries when max size exceeded", () => {
      const cache = new LruCache<string, number>(3, 2);

      cache.set("a", 1); // oldest
      cache.set("b", 2);
      cache.set("c", 3);
      cache.set("d", 4); // triggers eviction (a, b removed)

      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
    });

    it("get moves entry to most-recently-used position", () => {
      const cache = new LruCache<string, number>(3, 1);

      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);

      // Access "a" to make it recently used
      cache.get("a");

      // Adding new entry evicts LRU ("b")
      cache.set("d", 4);

      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
    });

    it("set on existing key updates value and moves to MRU", () => {
      const cache = new LruCache<string, number>(3, 1);

      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);

      // Update "a" — should move to MRU
      cache.set("a", 10);

      // Eviction should hit "b" now
      cache.set("d", 4);

      expect(cache.get("a")).toBe(10);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
    });

    it("delete removes from ordering", () => {
      const cache = new LruCache<string, number>(3, 2);

      cache.set("a", 1);
      cache.set("b", 2);
      cache.delete("a");

      cache.set("c", 3);
      cache.set("d", 4); // only "b" and "c" exist — no eviction needed yet
      expect(cache.size).toBe(3);
    });

    it("clear empties everything", () => {
      const cache = new LruCache<string, number>(10);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
    });
  });
});
