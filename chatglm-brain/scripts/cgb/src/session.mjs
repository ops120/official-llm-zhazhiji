import fs from "node:fs";
import path from "node:path";
import { dirs, ensureDir, readJson, writeJson, workspaceId, nowIso } from "./paths.mjs";
import { log } from "./logger.mjs";

export const PROTOCOL_STATES = ["INIT", "PLAN_RECEIVED", "EXECUTING", "EXECUTED_LOCAL", "EXECUTED_SENT", "DONE", "BLOCKED"];
export const WAITING_FOR = ["none", "BRAIN_PLAN", "BRAIN_REVIEW", "USER"];

const CAPS = { originalGoal: 500, completedSubtasks: 800, knownIssues: 800, nextExpectedStep: 400, title: 200 };

function clip(value, max) {
  if (typeof value !== "string") return value;
  const v = value.trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

export function sessionFile(wsid = workspaceId()) {
  return path.join(dirs().threads, `${wsid}.json`);
}

function emptySession(wsid) {
  return {
    workspaceId: wsid,
    threadUrl: null,
    title: null,
    taskId: null,
    iteration: 0,
    state: null,
    checkpoint: null,
    updatedAt: null,
  };
}

export function getSession(wsid = workspaceId()) {
  return readJson(sessionFile(wsid)) ?? emptySession(wsid);
}

/**
 * 合并式写入。支持：
 * - 普通字段（threadUrl/title/taskId/iteration/state）
 * - `--clear-checkpoint` → patch.clearCheckpoint
 * - checkpoint 字段 → patch.checkpointPatch
 */
export function setSession(patch, wsid = workspaceId()) {
  const current = getSession(wsid);
  const next = { ...current, ...patch, workspaceId: wsid, updatedAt: nowIso() };

  if (patch.clearCheckpoint) {
    next.checkpoint = null;
    delete next.clearCheckpoint;
  }
  if (patch.checkpointPatch) {
    const cp = { ...(current.checkpoint ?? {}), ...patch.checkpointPatch };
    for (const [k, cap] of Object.entries(CAPS)) {
      if (typeof cp[k] === "string") cp[k] = clip(cp[k], cap);
    }
    if (!cp.taskId) cp.taskId = next.taskId ?? null;
    if (cp.protocolState && !PROTOCOL_STATES.includes(cp.protocolState)) {
      throw Object.assign(new Error(`非法 protocolState: ${cp.protocolState}`), { code: "INVALID_ARGUMENTS" });
    }
    if (cp.waitingFor && !WAITING_FOR.includes(cp.waitingFor)) {
      throw Object.assign(new Error(`非法 waitingFor: ${cp.waitingFor}`), { code: "INVALID_ARGUMENTS" });
    }
    cp.updatedAt = nowIso();
    next.checkpoint = cp;
    delete next.checkpointPatch;
  }
  if (typeof next.title === "string") next.title = clip(next.title, CAPS.title);

  ensureDir(dirs().threads);
  return writeJson(sessionFile(wsid), next);
}

/** 审计：每次问答只记元数据，默认不落正文。 */
export function appendAudit(entry, wsid = workspaceId()) {
  const d = dirs();
  ensureDir(d.outputs);
  fs.appendFileSync(path.join(d.outputs, `${wsid}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function saveDebugHtml(html, tag = "page") {
  const d = dirs();
  ensureDir(d.debug);
  const file = path.join(d.debug, `${tag}-${Date.now()}.html`);
  fs.writeFileSync(file, html, { mode: 0o600 });
  return file;
}

/* --------------------------------- 全局会话锁 -------------------------------- */

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // EPERM = 存在但无权发信号，也算活着
  }
}

const LOCK_FILE = () => path.join(dirs().root, "qwb.lock");

/**
 * 全局会话锁：profile 是 Chrome ProcessSingleton 排他资源，同一时间只允许一个
 * qwb 会话打开浏览器（README 行为约定；并发第二个会拿到 `LOCKED`）。
 * - `O_EXCL` 独占创建锁文件，内容含 pid —— 持有者进程已死则视为陈旧锁，直接接管；
 * - ⚠️ 必须先拿到锁再调 launchBrowser（其中的孤儿浏览器回收会按 profile 杀进程，
 *   没锁的话会误杀另一个正在运行的会话的浏览器）。
 * 返回 `{ ok:true, release }` 或 `{ ok:false, holder }`。
 */
export function acquireLock({ command = "" } = {}) {
  const file = LOCK_FILE();
  ensureDir(dirs().root);
  for (;;) {
    let holder = null;
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, command, startedAt: nowIso() }));
      fs.closeSync(fd);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        holder = null;
      }
      if (holder && pidAlive(holder.pid)) {
        return { ok: false, holder, lockFile: file };
      }
      log("warn", `发现陈旧锁（pid=${holder?.pid ?? "?"}），已接管`);
      try {
        fs.unlinkSync(file);
      } catch {
        /* 抢不到就下一轮再试 */
      }
      continue;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const cur = JSON.parse(fs.readFileSync(file, "utf8"));
        if (cur?.pid !== process.pid) return; // 锁已被别人接管，不要误删
        fs.unlinkSync(file);
      } catch {
        /* 文件已不在 */
      }
    };
    process.on("exit", release);
    return { ok: true, release };
  }
}
