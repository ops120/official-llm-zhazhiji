import fs from "node:fs";
import path from "node:path";
import { dirs, ensureDir, readJson, writeJson, workspaceId, nowIso } from "./paths.mjs";

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
