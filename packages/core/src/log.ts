export type LogLevel = "info" | "warn" | "error";

/** Where log lines go: VS Code's output channel, the CLI's log file. */
export type LogSink = (level: LogLevel, message: string) => void;

export const SECRET_MASK = "[ключ скрыт]";

/** Things that look like API keys even when we don't know the key itself: masked whole. */
const KEY_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g,
  // Google API keys, GitHub tokens, AWS access keys, JWTs (OAuth access tokens).
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
/** Here the label stays and only the value is masked. */
const LABELLED_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${SECRET_MASK}`],
  // A password inside an address: postgres://user:password@host.
  [/(:\/\/[^\s/:@]*:)[^\s/@]+@/g, `$1${SECRET_MASK}@`],
  // access_token=..., "client_secret": "...", password: ...
  [/\b([A-Za-z0-9_]*?(?:api[_-]?key|token|secret|password))(["'\s:=]+)[^\s"',;&]{8,}/gi, `$1$2${SECRET_MASK}`],
];

/**
 * The diagnostic journal. Only metadata goes in: what happened, how long it
 * took, status codes. Never the conversation, file contents or keys: every
 * line passes through redact() before it is kept or written.
 */
export class Log {
  /** The latest error line, for the problem report. */
  lastError?: string;
  private lines: string[] = [];
  private secrets = new Set<string>();

  constructor(
    private sink?: LogSink,
    private keep = 500,
  ) {}

  setSink(sink: LogSink | undefined): void {
    this.sink = sink;
  }

  /** Remembers a key so it is masked wherever it shows up (e.g. echoed in a server error). */
  addSecret(secret: string | undefined): void {
    if (secret && secret.trim().length >= 6) this.secrets.add(secret.trim());
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  /** The most recent lines, oldest first, with time and level. */
  recent(): string[] {
    return [...this.lines];
  }

  redact(text: string): string {
    let out = text;
    // Longest first, so a key that contains another key is masked whole.
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(SECRET_MASK);
    for (const re of KEY_PATTERNS) out = out.replace(re, SECRET_MASK);
    for (const [re, to] of LABELLED_PATTERNS) out = out.replace(re, to);
    return out;
  }

  private write(level: LogLevel, message: string): void {
    const clean = this.redact(message.replace(/\s+/g, " ").trim());
    const line = `${new Date().toISOString()} [${level}] ${clean}`;
    this.lines.push(line);
    if (this.lines.length > this.keep) this.lines.splice(0, this.lines.length - this.keep);
    if (level === "error") this.lastError = line;
    try {
      this.sink?.(level, clean);
    } catch {
      // a broken log must never break the agent
    }
  }
}
