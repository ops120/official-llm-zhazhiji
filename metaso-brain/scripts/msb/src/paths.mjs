import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const VERSION = "1.0.0";
export const SERVICE = "msb-cli";

export function stateDir() {
  const override = process.env.MSB_STATE_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  const home = os.homedir();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(base, "metaso-brain");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "metaso-brain");
  }
  const xdg = process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(xdg, "metaso-brain");
}

export function dirs() {
  const root = stateDir();
  return {
    root,
    profile: path.join(root, "profile"),
    // 会话 cookie 的备份文件（Playwright 不保存 session cookie，必须显式导出）
    storageState: path.join(root, "storage-state.json"),
    downloads: path.join(root, "downloads"),
    deps: path.join(root, "deps"),
    threads: path.join(root, "threads"),
    logs: path.join(root, "logs"),
    outputs: path.join(root, "outputs"),
    debug: path.join(root, "debug"),
    prefs: path.join(root, "prefs.json"),
    updateCheck: path.join(root, "update-check.json"),
    closeFlag: path.join(root, "CLOSE"),
  };
}

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 无 chmod 时忽略 */
  }
  return value;
}

/** 稳定的工作区 id（按调用目录）。 */
export function workspaceId(cwd = process.cwd()) {
  const norm = process.platform === "win32" || process.platform === "darwin" ? cwd.toLowerCase() : cwd;
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

export function nowIso() {
  return new Date().toISOString();
}
