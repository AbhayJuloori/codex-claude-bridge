export interface SessionRecord {
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  requestCount: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  touch(sessionId: string): SessionRecord {
    const now = new Date().toISOString();
    const existing = this.sessions.get(sessionId);

    if (existing) {
      existing.lastSeenAt = now;
      existing.requestCount += 1;
      return existing;
    }

    const created: SessionRecord = {
      sessionId,
      firstSeenAt: now,
      lastSeenAt: now,
      requestCount: 1
    };

    this.sessions.set(sessionId, created);
    return created;
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }
}
