import { App } from 'obsidian';

export interface DiarySession {
  userId: string;
  state: 'IDLE' | 'REFLECTING' | 'SAVING';
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  followUpCount: number;
  startedAt: Date;
  lastActivityAt: Date;
  /** TG send time of first user msg in session — used for diary timestamp/path. */
  firstMsgAt?: Date;
  activeTags?: string[];
  activeEntities?: string[];
  silentReplyIndex?: number;
  /** "lat,lng" — captured from TG location msg or photo EXIF; emitted to frontmatter for map view. */
  activeLocation?: string;
  /** Reverse-geocoded place name. */
  activePlaceName?: string;
}

interface PersistedSession extends Omit<DiarySession, 'startedAt' | 'lastActivityAt' | 'firstMsgAt'> {
  startedAt: string;
  lastActivityAt: string;
  firstMsgAt?: string;
}

export class SessionManager {
  private sessions: Map<string, DiarySession> = new Map();
  private app: App | null = null;
  private path: string | null = null;

  attachStorage(app: App, pluginDir: string): void {
    this.app = app;
    this.path = `${pluginDir}/sessions.json`;
  }

  getSession(userId: string): DiarySession | undefined {
    return this.sessions.get(userId);
  }

  getAllSessions(): DiarySession[] {
    return Array.from(this.sessions.values());
  }

  createSession(userId: string, at?: Date): DiarySession {
    const now = at ?? new Date();
    const session: DiarySession = {
      userId,
      state: 'IDLE',
      messages: [],
      followUpCount: 0,
      startedAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(userId, session);
    return session;
  }

  clearSession(userId: string): void {
    this.sessions.delete(userId);
  }

  isSessionExpired(session: DiarySession, timeoutMinutes: number): boolean {
    return this.isSessionExpiredAt(session, new Date(), timeoutMinutes);
  }

  /** Check expiry relative to a specific reference time (e.g. a message's send timestamp). */
  isSessionExpiredAt(session: DiarySession, at: Date, timeoutMinutes: number): boolean {
    const diff = (at.getTime() - session.lastActivityAt.getTime()) / 1000 / 60;
    return diff > timeoutMinutes;
  }

  async load(): Promise<void> {
    if (!this.app || !this.path) return;
    try {
      if (!(await this.app.vault.adapter.exists(this.path))) return;
      const raw = await this.app.vault.adapter.read(this.path);
      const parsed: PersistedSession[] = JSON.parse(raw);
      this.sessions.clear();
      for (const p of parsed) {
        this.sessions.set(p.userId, {
          ...p,
          startedAt: new Date(p.startedAt),
          lastActivityAt: new Date(p.lastActivityAt),
          firstMsgAt: p.firstMsgAt ? new Date(p.firstMsgAt) : undefined,
        });
      }
    } catch (e) {
      console.error('Diary Bot: failed to load sessions', e);
    }
  }

  async flush(): Promise<void> {
    if (!this.app || !this.path) return;
    try {
      const data: PersistedSession[] = Array.from(this.sessions.values()).map((s) => ({
        ...s,
        startedAt: s.startedAt.toISOString(),
        lastActivityAt: s.lastActivityAt.toISOString(),
        firstMsgAt: s.firstMsgAt ? s.firstMsgAt.toISOString() : undefined,
      }));
      await this.app.vault.adapter.write(this.path, JSON.stringify(data));
    } catch (e) {
      console.error('Diary Bot: failed to flush sessions', e);
    }
  }
}
