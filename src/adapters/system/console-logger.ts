import type { Logger } from "../../ports/logger.js";

function write(level: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
  const record = {
    at: new Date().toISOString(),
    level,
    message,
    ...(fields === undefined ? {} : { fields }),
  };
  const line = `${JSON.stringify(record)}\n`;
  if (level === "error" || level === "warn") process.stderr.write(line);
  else process.stdout.write(line);
}

export class ConsoleLogger implements Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    write("debug", message, fields);
  }

  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    write("info", message, fields);
  }

  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    write("warn", message, fields);
  }

  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    write("error", message, fields);
  }
}
