import fs from "node:fs";
import path from "node:path";
import { appendJsonLine, ensureDirectory, fileExists, readJsonFileSafe, writeJsonFile } from "../config/fs-utils.js";
import type { BridgeConfig } from "../config.js";

export interface SessionMessageRecord {
  ts: string;
  role: "user" | "assistant" | "system";
  content: string;
  requestId?: string;
}

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  requestCount: number;
  messages: SessionMessageRecord[];
}

export class PersistentSessionStore {
  private readonly sessionDir: string;

  constructor(config: BridgeConfig) {
    this.sessionDir = path.join(config.runtime.stateDir, "sessions");
    ensureDirectory(this.sessionDir);
  }

  get(sessionId: string): SessionRecord | null {
    return readJsonFileSafe<SessionRecord>(this.getSessionPath(sessionId));
  }

  touch(sessionId: string): SessionRecord {
    const existing = this.get(sessionId);
    const now = new Date().toISOString();

    if (existing) {
      existing.updatedAt = now;
      existing.requestCount += 1;
      writeJsonFile(this.getSessionPath(sessionId), existing);
      return existing;
    }

    const created: SessionRecord = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      requestCount: 1,
      messages: []
    };

    writeJsonFile(this.getSessionPath(sessionId), created);
    return created;
  }

  appendMessages(sessionId: string, messages: SessionMessageRecord[]): SessionRecord {
    const session = this.touch(sessionId);
    session.messages.push(...messages);
    session.updatedAt = new Date().toISOString();
    writeJsonFile(this.getSessionPath(sessionId), session);
    return session;
  }

  appendEvent(sessionId: string, event: Record<string, unknown>): void {
    appendJsonLine(path.join(this.sessionDir, `${sessionId}.events.jsonl`), {
      ts: new Date().toISOString(),
      ...event
    });
  }

  list(): SessionRecord[] {
    const sessionFiles = listSessionFiles(this.sessionDir);
    return sessionFiles
      .map((filePath) => readJsonFileSafe<SessionRecord>(filePath))
      .filter((item): item is SessionRecord => Boolean(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getEventLogPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.events.jsonl`);
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.json`);
  }
}

function listSessionFiles(sessionDir: string): string[] {
  if (!fileExists(sessionDir)) {
    return [];
  }

  return fs
    .readdirSync(sessionDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".events.jsonl"))
    .map((name) => path.join(sessionDir, name));
}
