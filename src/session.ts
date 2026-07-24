// Change-tracking session store (issue #36). A session pins the baseline
// text of one file between "start tracking" and "stop". Persisted to
// sessions.json in the plugin directory — separate from data.json so
// settings writes and (potentially large) baselines never rewrite each
// other. Persistence is injected; main.ts supplies a Vault-adapter-backed
// implementation.

export interface SessionData {
  baseline: string;
  startedAt: string;
}

export interface SessionPersistence {
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
}

interface StoreFile {
  version: 1;
  sessions: Record<string, SessionData>;
}

export class SessionStore {
  private sessions = new Map<string, SessionData>();

  constructor(private persistence: SessionPersistence) {}

  static async load(
    persistence: SessionPersistence,
    fileExists: (path: string) => boolean,
  ): Promise<SessionStore> {
    const store = new SessionStore(persistence);
    let raw: string | null = null;
    try {
      raw = await persistence.read();
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        const data = JSON.parse(raw) as Partial<StoreFile>;
        if (data.version === 1 && data.sessions && typeof data.sessions === "object") {
          for (const [path, s] of Object.entries(data.sessions)) {
            if (
              fileExists(path) &&
              s &&
              typeof s.baseline === "string" &&
              typeof s.startedAt === "string"
            ) {
              store.sessions.set(path, { baseline: s.baseline, startedAt: s.startedAt });
            }
          }
        }
      } catch {
        // Corrupt store: start empty rather than fail the plugin load.
      }
    }
    return store;
  }

  has(path: string): boolean {
    return this.sessions.has(path);
  }

  get(path: string): SessionData | null {
    return this.sessions.get(path) ?? null;
  }

  async start(path: string, baseline: string, startedAt: string): Promise<void> {
    this.sessions.set(path, { baseline, startedAt });
    await this.save();
  }

  async end(path: string): Promise<void> {
    if (!this.sessions.delete(path)) return;
    await this.save();
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const s = this.sessions.get(oldPath);
    if (!s) return;
    this.sessions.delete(oldPath);
    this.sessions.set(newPath, s);
    await this.save();
  }

  private async save(): Promise<void> {
    const file: StoreFile = { version: 1, sessions: Object.fromEntries(this.sessions) };
    await this.persistence.write(JSON.stringify(file));
  }
}
