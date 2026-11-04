import { describe, test, expect } from "vitest";
import { cachedModelBytes, MODEL_CACHE, type ModelCacheStorage } from "./modelCache";

// An in-memory CacheStorage stand-in (Response exists in node 18+).
function memStorage() {
  const store = new Map<string, ArrayBuffer>();
  const opened: string[] = [];
  const storage: ModelCacheStorage = {
    async open(name) {
      opened.push(name);
      return {
        async match(key) {
          const b = store.get(key);
          return b ? new Response(b) : undefined;
        },
        async put(key, res) {
          store.set(key, await res.arrayBuffer());
        },
      };
    },
  };
  return { storage, store, opened };
}

const URL_ = "https://huggingface.co/x/resolve/main/demucs/htdemucs-core.onnx";
const bytes = (...v: number[]) => new Uint8Array(v).buffer;

describe("cachedModelBytes — model weights download once, then come from the cache", () => {
  test("a second load is served from the cache, not the network", async () => {
    const { storage, opened } = memStorage();
    let downloads = 0;
    const dl = async () => (downloads++, bytes(1, 2, 3));
    const a = await cachedModelBytes(URL_, dl, storage);
    const b = await cachedModelBytes(URL_, dl, storage);
    expect(downloads).toBe(1);
    expect([...new Uint8Array(a!)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(b!)]).toEqual([1, 2, 3]);
    expect(opened.every((n) => n === MODEL_CACHE)).toBe(true);
  });

  test("a 404 (null) is not cached, so a later real file is still fetched", async () => {
    const { storage, store } = memStorage();
    expect(await cachedModelBytes(URL_ + ".data", async () => null, storage)).toBeNull();
    expect(store.size).toBe(0);
  });

  test("a failed download is not cached and propagates", async () => {
    const { storage, store } = memStorage();
    await expect(cachedModelBytes(URL_, async () => Promise.reject(new Error("blip")), storage)).rejects.toThrow("blip");
    expect(store.size).toBe(0);
  });

  test("a broken cache degrades to the network instead of failing the load", async () => {
    const broken: ModelCacheStorage = { open: async () => Promise.reject(new Error("SecurityError")) };
    expect([...new Uint8Array((await cachedModelBytes(URL_, async () => bytes(9), broken))!)]).toEqual([9]);
    const noCache = await cachedModelBytes(URL_, async () => bytes(7), null);
    expect([...new Uint8Array(noCache!)]).toEqual([7]);
  });

  test("an empty cached entry is treated as a miss", async () => {
    const { storage, store } = memStorage();
    store.set(URL_, new ArrayBuffer(0));
    let downloads = 0;
    await cachedModelBytes(URL_, async () => (downloads++, bytes(5)), storage);
    expect(downloads).toBe(1);
    expect(new Uint8Array(store.get(URL_)!)[0]).toBe(5);
  });
});
