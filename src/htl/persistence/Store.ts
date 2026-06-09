// Typed, namespaced, versioned localStorage wrapper. Every read is
// corruption-safe (bad JSON → fallback) and every write is quota-safe (a failed
// write never throws into app code). Keys are namespaced `htl.<name>.v<version>`
// so schema bumps don't collide with old data.

const NS = "htl";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Store<T> {
  readonly key: string;

  constructor(
    name: string,
    private readonly fallback: T,
    version = 1,
  ) {
    this.key = `${NS}.${name}.v${version}`;
  }

  get(): T {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw != null) {
        const parsed = JSON.parse(raw);
        // Shallow-merge object shapes so added fields pick up their defaults.
        if (isPlainObject(this.fallback) && isPlainObject(parsed)) {
          return { ...this.fallback, ...parsed } as T;
        }
        return parsed as T;
      }
    } catch {
      /* corrupt or unavailable — fall through to default */
    }
    return this.fallback;
  }

  set(value: T): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(value));
    } catch {
      /* quota exceeded / private mode — keep running in memory */
    }
  }

  update(fn: (prev: T) => T): T {
    const next = fn(this.get());
    this.set(next);
    return next;
  }

  clear(): void {
    try {
      localStorage.removeItem(this.key);
    } catch {
      /* ignore */
    }
  }
}

// One-time migration of a legacy key onto a new Store key. Runs only if the new
// key is empty and the old key exists; the old key is then removed.
export function migrateLegacyKey<T>(oldKey: string, store: Store<T>): void {
  try {
    if (localStorage.getItem(store.key) != null) return;
    const raw = localStorage.getItem(oldKey);
    if (raw == null) return;
    localStorage.setItem(store.key, raw);
    localStorage.removeItem(oldKey);
  } catch {
    /* ignore */
  }
}
