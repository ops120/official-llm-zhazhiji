import fs from "node:fs";
import path from "node:path";
import { dirs, ensureDir } from "./paths.mjs";

/** 通用脱敏：日志与发送闸门共用。 */
export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  const shapes = [
    [/\b(sk|rk)-[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]"],
    [/\bghp_[A-Za-z0-9]{12,}/g, "[REDACTED_KEY]"],
    [/\bgithub_pat_[A-Za-z0-9_]{12,}/g, "[REDACTED_KEY]"],
    [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "[REDACTED_KEY]"],
    [/\bAKIA[0-9A-Z]{12,}/g, "[REDACTED_KEY]"],
    [/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_KEY]"],
    [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [REDACTED]"],
    [/((?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
  ];
  for (const [re, rep] of shapes) out = out.replace(re, rep);
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function enabled(level) {
  const want = process.env.MSB_LOG_LEVEL || "info";
  return LEVELS[level] >= (LEVELS[want] ?? 20);
}

let logFile = null;
function file() {
  if (logFile) return logFile;
  const d = dirs();
  ensureDir(d.logs);
  logFile = path.join(d.logs, "msb.log");
  return logFile;
}

/** 日志行必须单行：折叠换行 + 去掉 ANSI 转义（Playwright 报错自带）。 */
function oneLine(s) {
  return s
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\s*\r?\n\s*/g, " ⏎ ")
    .trim();
}

export function log(level, message, extra) {
  if (!enabled(level)) return;
  const payload = extra === undefined ? "" : ` ${oneLine(redact(typeof extra === "string" ? extra : JSON.stringify(extra)))}`;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${oneLine(redact(String(message)))}${payload}\n`;
  try {
    fs.appendFileSync(file(), line, { mode: 0o600 });
  } catch {
    /* 日志绝不拖垮主流程 */
  }
  if (process.env.MSB_LOG_STDERR === "1" || level === "error") process.stderr.write(line);
}

export function tailLines(n = 50, { verbose = false } = {}) {
  try {
    const lines = fs.readFileSync(file(), "utf8").split(/\r?\n/).filter(Boolean);
    const filtered = verbose ? lines : lines.filter((l) => !l.includes(" DEBUG "));
    return filtered.slice(-n);
  } catch {
    return [];
  }
}
