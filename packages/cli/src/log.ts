import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import * as path from "node:path";
import { Log, type LogSink } from "@dimosi/core";
import { configDir } from "./config";

export const MAX_LOG_BYTES = 1024 * 1024;

export const logFilePath = () => path.join(configDir(), "dimosi.log");

/**
 * Appends to dimosi.log. Past `maxBytes` the file becomes dimosi.log.1 (the
 * previous one is replaced), so the journal never grows without bound.
 * Synchronous: lines are not lost when the CLI exits right after.
 */
export function fileSink(file = logFilePath(), maxBytes = MAX_LOG_BYTES): LogSink {
  let size = -1;
  return (level, message) => {
    try {
      if (size < 0) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        try {
          size = statSync(file).size;
        } catch {
          size = 0;
        }
      }
      if (size > maxBytes) {
        renameSync(file, `${file}.1`);
        size = 0;
      }
      const line = `${new Date().toISOString()} [${level}] ${message}\n`;
      appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
      size += Buffer.byteLength(line);
    } catch {
      // no journal is better than a CLI that fails because of it
    }
  };
}

/** The CLI's journal; main() connects it to the file. */
export const log = new Log();
