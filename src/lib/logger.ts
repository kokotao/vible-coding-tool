import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { Writable } from "node:stream";

const LOG_FILE_PREFIX = "gateway-";
const LOG_FILE_SUFFIX = ".log";
const LOG_FILE_NAME_PATTERN = /^gateway-(\d{4})-(\d{2})-(\d{2})\.log$/;

type DailyRollingFileStreamOptions = {
  logDir: string;
  retentionDays: number;
};

class DailyRollingFileStream extends Writable {
  private readonly logDir: string;
  private readonly retentionDays: number;
  private currentDateKey: string | null = null;
  private currentStream: WriteStream | null = null;

  constructor(options: DailyRollingFileStreamOptions) {
    super();
    this.logDir = resolve(options.logDir);
    this.retentionDays = Math.max(1, Math.floor(options.retentionDays));
    this.ensureStreamForDate(new Date());
  }

  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      this.ensureStreamForDate(new Date());
      if (!this.currentStream) {
        callback(new Error("log stream is not initialized"));
        return;
      }

      this.currentStream.write(chunk, encoding, (error) => {
        callback(error ?? undefined);
      });
    } catch (error) {
      callback(error as Error);
    }
  }

  _final(callback: (error?: Error | null) => void) {
    if (!this.currentStream) {
      callback();
      return;
    }
    this.currentStream.end(() => callback());
  }

  private ensureStreamForDate(date: Date) {
    const nextDateKey = formatDateKey(date);
    if (this.currentDateKey === nextDateKey && this.currentStream) {
      return;
    }

    const nextPath = resolveLogFilePath(this.logDir, date);
    mkdirSync(dirname(nextPath), { recursive: true });
    const nextStream = createWriteStream(nextPath, { flags: "a" });

    const previousStream = this.currentStream;
    this.currentStream = nextStream;
    this.currentDateKey = nextDateKey;

    if (previousStream) {
      previousStream.end();
    }

    cleanupExpiredLogs(this.logDir, this.retentionDays, date);
  }
}

export function resolveLogFilePath(logDir: string, date = new Date()) {
  return resolve(logDir, `${LOG_FILE_PREFIX}${formatDateKey(date)}${LOG_FILE_SUFFIX}`);
}

export function createLoggerOptions(level: string, logDir: string, retentionDays: number) {
  if (process.env.NODE_ENV === "test") {
    return {
      level,
      enabled: false
    };
  }

  return {
    level,
    stream: new DailyRollingFileStream({
      logDir,
      retentionDays
    })
  };
}

function cleanupExpiredLogs(logDir: string, retentionDays: number, now: Date) {
  const absoluteLogDir = resolve(logDir);
  mkdirSync(absoluteLogDir, { recursive: true });

  const cutoffDate = startOfDay(now);
  cutoffDate.setDate(cutoffDate.getDate() - (retentionDays - 1));

  for (const entry of readdirSync(absoluteLogDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const matched = entry.name.match(LOG_FILE_NAME_PATTERN);
    if (!matched) {
      continue;
    }

    const fileDate = parseDateKey(matched[1], matched[2], matched[3]);
    if (!fileDate) {
      continue;
    }

    if (fileDate >= cutoffDate) {
      continue;
    }

    rmSync(resolve(absoluteLogDir, entry.name), { force: true });
  }
}

function parseDateKey(year: string, month: string, day: string) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  const parsedDay = Number(day);
  if (!Number.isFinite(parsedYear) || !Number.isFinite(parsedMonth) || !Number.isFinite(parsedDay)) {
    return null;
  }

  const date = new Date(parsedYear, parsedMonth - 1, parsedDay, 0, 0, 0, 0);
  if (date.getFullYear() !== parsedYear || date.getMonth() !== parsedMonth - 1 || date.getDate() !== parsedDay) {
    return null;
  }

  return date;
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}
