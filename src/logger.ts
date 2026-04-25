import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const priority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  private readonly level: LogLevel;
  private readonly logfile: string;

  constructor(config: BridgeConfig) {
    this.level = config.logging.level;
    fs.mkdirSync(config.logging.dir, { recursive: true });
    this.logfile = path.join(config.logging.dir, "bridge.log");
  }

  debug(component: string, message: string, fields?: Record<string, unknown>): void {
    this.write("debug", component, message, fields);
  }

  info(component: string, message: string, fields?: Record<string, unknown>): void {
    this.write("info", component, message, fields);
  }

  warn(component: string, message: string, fields?: Record<string, unknown>): void {
    this.write("warn", component, message, fields);
  }

  error(component: string, message: string, fields?: Record<string, unknown>): void {
    this.write("error", component, message, fields);
  }

  private write(
    level: LogLevel,
    component: string,
    message: string,
    fields?: Record<string, unknown>
  ): void {
    if (priority[level] < priority[this.level]) {
      return;
    }

    const record = {
      ts: new Date().toISOString(),
      level,
      component,
      message,
      ...fields
    };

    const line = JSON.stringify(record);
    fs.appendFileSync(this.logfile, `${line}\n`);

    if (level === "error" || level === "warn") {
      console.error(line);
      return;
    }

    console.log(line);
  }
}
