const DEFAULT_EXPIRY_MS = 10 * 60 * 1000;

interface SessionRecord {
  createdAt: number;
  expiresAt: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  static makeKey(conversationId: string, taskSuffix: string): string {
    const safe = taskSuffix.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40);
    return conversationId + '__' + safe;
  }

  has(key: string): boolean {
    const record = this.sessions.get(key);
    if (!record) return false;
    if (Date.now() > record.expiresAt) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, maxWallTimeMs = DEFAULT_EXPIRY_MS): void {
    this.sessions.set(key, {
      createdAt: Date.now(),
      expiresAt: Date.now() + maxWallTimeMs,
    });
  }

  delete(key: string): void {
    this.sessions.delete(key);
  }

  purgeExpired(): void {
    const now = Date.now();
    for (const [key, record] of this.sessions) {
      if (now > record.expiresAt) this.sessions.delete(key);
    }
  }
}
