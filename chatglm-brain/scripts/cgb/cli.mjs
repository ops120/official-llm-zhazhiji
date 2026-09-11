#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { VERSION, dirs, ensureDir, writeJson, readJson, workspaceId, nowIso } from "./src/paths.mjs";
import { log, tailLines } from "./src/logger.mjs";
import { sanitizeOutbound } from "./src/sanitize.mjs";
import {
  getSession,
  setSession,
  appendAudit,
  saveDebugHtml,
  acquireLock,
} from "./src/session.mjs";
import {
  launchBrowser,
  findBrowser,
  depsInstalled,
  depsEntry,
  exportStorageState,
  readLoginCookies,
  collapseToSinglePage,
  closeBrowser,
} from "./src/browser.mjs";
import * as site from "./src/site.mjs";

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
    version: { type: "boolean", default: false },
    model: { type: "string" },
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    attach: { type: "string" },
    thread: { type: "string" },
    timeout: { type: "string" },
    deep: { type: "boolean", default: false },
    html: { type: "boolean", default: false },
    debug: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    "allow-sensitive": { type: "boolean", default: false },
    "allow-large": { type: "boolean", default: false },
    "keep-open": { type: "boolean", default: false },
    "captcha-wait": { type: "string", default: "180000" },
    verbose: { type: "boolean", default: false },
    lines: { type: "string" },
    n: { type: "string" },
    force: { type: "boolean", default: false },
    url: { type: "string" },
    title: { type: "string" },
    task: { type: "string" },
    iteration: { type: "string" },
    state: { type: "string" },
    protocol: { type: "string" },
    "protocol-state": { type: "string" },
    "waiting-for": { type: "string" },
    "next-step": { type: "string" },
    goal: { type: "string" },
    "known-issues": { type: "string" },
    "clear-checkpoint": { type: "boolean", default: false },
  },
});

const cmd = String(positionals[0] ?? "help").toLowerCase();
const json = !!flags.json;

function emit(payload, { exitCode = 0 } = {}) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else printHuman(payload);
  if (exitCode) process.exitCode = exitCode;
  return payload;
}

function fail(reason, message, extra = {}) {
  const payload = { ok: false, reason, message, ...extra };
  log("error", `${reason}: ${message}`);
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`✗ ${reason}: ${message}\n`);
  process.exitCode = 1;
  return payload;
}

function printHuman(payload) {
  if (!payload || typeof payload !== "object" || payload.ok === false) return;
  if (typeof payload.text === "string") {
    process.stdout.write(`${payload.text}\n`);
    const m = payload.modes ?? {};
    process.stdout.write(
      `\n来源：chatglm.cn · 模型：${m.model ?? "-"} · request: ${payload.requestId ?? "-"} · 截断：${payload.truncated ? "是" : "否"}\n`
    );
    if (payload.files?.length) {
      process.stdout.write(`产物：\n${payload.files.map((f) => `  ${f.file} (${f.bytes} bytes)`).join("\n")}\n`);
    }
    return;
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k === "ok") continue;
    process.stdout.write(`✓ ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}\n`);
  }
}

function newRequestId() {
  return `cgb_${crypto.randomBytes(2).toString("hex")}`;
}

/* --------------------------- 中断清理（防孤儿窗口） --------------------------- */

/**
 * 进程被 Ctrl-C / kill / 任务取消时，Node 直接退出会留下一个孤儿 Chrome 窗口
 * （它还占着 profile 排他锁，会让下一次运行失败）。
 * 这里注册信号处理，退出前优雅关闭浏览器。
 */
let activeCtx = null;
let cleaningUp = false;
async function cleanupAndExit(signal) {
  if (cleaningUp) return;
  cleaningUp = true;
  process.stderr.write(`
收到 ${signal}，正在关闭浏览器…
`);
  if (activeCtx) await closeBrowser(activeCtx).catch(() => {});
  process.exit(130);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanupAndExit(sig);
  });
}

/* ------------------------- 访问验证：提示与失败文案 ------------------------- */

/**
 * 智谱风控提示。原则：
 *   - 人机验证一律由用户本人在浏览器里完成，CLI **只等待，绝不代操作**；
 *   - 不能干等 —— 每次触发都要在终端讲清楚：触发了风控、需要人工验证、还剩多少时间。
 */
function captchaNotice(scene, waitMs) {
  process.stderr.write(
    `⚠️  ${scene}：触发了智谱风控，需要人工验证。\n` +
      `   请在打开的浏览器窗口里完成滑块拖动（CLI 不代操作，只等待，最多 ${Math.round(waitMs / 1000)} 秒）。\n` +
      "   通过后设备会被记住，一般会安静一段时间；若频繁弹出，建议降低提问频率或稍后再试。\n"
  );
}

function captchaFailMessage(waitMs) {
  return (
    `人机验证未在 ${Math.round(waitMs / 1000)} 秒内完成（风控要求人工操作，CLI 不会代操作）。` +
    "重跑同一条命令，出现验证时尽快完成即可；频繁触发时建议过段时间再试。"
  );
}

/**
 * 打开浏览器的命令共用入口：先拿全局会话锁（profile 是排他资源，且孤儿浏览器
 * 回收必须持锁进行，否则会误杀另一会话的窗口），再执行，finally 释放。
 */
async function withBrowserLock(command, fn) {
  const lock = acquireLock({ command });
  if (!lock.ok) {
    return fail(
      "LOCKED",
      `另一个 cgb 会话正在运行（pid=${lock.holder?.pid ?? "?"}，${lock.holder?.command ?? "?"}），同一时间只允许一个会话占用浏览器。等它结束后再试。`,
      { holder: lock.holder ?? null, lockFile: lock.lockFile }
    );
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/* ------------------------------ [CGB] 协议 ------------------------------ */

const PROTOCOL_STATES = ["INIT", "PLAN", "EXECUTING", "EXECUTED", "REVIEW", "HANDOFF"];
const CHECKPOINT_FOR_REPLY = {
  PLAN: { protocolState: "PLAN_RECEIVED", waitingFor: "none" },
  REVIEW: { protocolState: "EXECUTED_SENT", waitingFor: "BRAIN_REVIEW" },
  DONE: { protocolState: "DONE", waitingFor: "none" },
  BLOCKED: { protocolState: "BLOCKED", waitingFor: "USER" },
};

export function buildProtocolMessage(state, body, { taskId, iteration }) {
  return `[CGB]\nSTATE: ${state}\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\n${body}`;
}

export function parseProtocolReply(text) {
  if (!text) return null;
  const state = text.match(/STATE:\s*([A-Z_]+)/);
  if (!state) return null;
  const task = text.match(/TASK_ID:\s*(\S+)/);
  const iter = text.match(/ITERATION:\s*(\d+)/);
  return { state: state[1], taskId: task ? task[1] : null, iteration: iter ? Number(iter[1]) : null };
}

/* ---------------------------------- setup --------------------------------- */

function installDeps() {
  const d = dirs();
  ensureDir(d.deps);
  writeJson(path.join(d.deps, "package.json"), {
    name: "cgb-deps",
    private: true,
    dependencies: { "playwright-core": "^1.40.0" },
  });
  const args = ["install", "--prefix", d.deps, "--no-audit", "--no-fund", "--loglevel", "error"];
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const res = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: "inherit", windowsHide: true })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
  return res.status === 0;
}

/**
 * 登录流程。
 * ⚠️ 智谱清言的 cookie 无法区分游客与登录（游客首次访问也会下发 chatglm_token 等四件套），
 *    登录成功判定必须看**界面**：「登录」按钮消失（`site.pageState().signedOut === false`）。
 * 智谱清言允许匿名问答（游客模式），登录解锁：更多额度、积分、云空间同步。
 */
async function waitLoginFlow({ timeoutMs }) {
  const ctx = await launchBrowser({ headless: false });
  activeCtx = ctx;
  try {
    const page = await collapseToSinglePage(ctx);
    await site.gotoSite(page);
    process.stderr.write("浏览器已打开。请完成智谱账号登录（手机号验证码，需你本人操作）。\n");
    process.stderr.write("（游客模式也可用；登录是为了更多额度与云空间同步，可直接关闭浏览器跳过。）\n");

    const started = Date.now();
    let lastBeat = 0;
    let st = await site.pageState(page).catch(() => null);
    let aborted = false;

    while (Date.now() - started < timeoutMs) {
      if (st && !st.signedOut && st.hasEditor) break;
      try {
        await page.waitForTimeout(3000);
        st = await site.pageState(page).catch(() => null);
      } catch {
        aborted = true; // 用户关了浏览器 = 跳过登录
        break;
      }
      const sec = Math.round((Date.now() - started) / 1000);
      if (sec - lastBeat >= 30) {
        lastBeat = sec;
        process.stderr.write(`  …等待登录 ${sec}s（登录按钮${st?.signedOut ? "仍可见" : "已消失"}）\n`);
      }
    }

    const d = dirs();
    const prefs = readJson(d.prefs) ?? {};
    if (aborted) return { ok: false, reason: "LOGIN_ABORTED", state: null };
    if (!st || st.signedOut || !st.hasEditor) {
      ensureDir(d.debug);
      return { ok: false, reason: "LOGIN_REQUIRED", state: st };
    }

    const ck = await readLoginCookies(ctx);
    const exported = await exportStorageState(ctx, d.storageState);
    writeJson(d.prefs, { ...prefs, lastLoginAt: nowIso() });
    return { ok: true, loginState: "logged-in", url: page.url(), sessionCookies: ck.loginCookies, storageState: exported };
  } finally {
    await closeBrowser(ctx); // 优雅关闭：确保 cookie 落盘
  }
}

async function cmdSetup() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) return fail("DEPENDENCY_MISSING", `需要 Node ≥ 20，当前 ${process.version}`);

  if (!depsInstalled()) {
    process.stderr.write("安装依赖（playwright-core）到状态目录…\n");
    if (!installDeps() || !depsInstalled()) return fail("DEPENDENCY_MISSING", `依赖安装失败（目标：${depsEntry()}）`);
  }
  const br = findBrowser();
  if (!br) return fail("DEPENDENCY_MISSING", "未找到系统 Chrome / Edge；请安装其一后重试。");

  const res = await withBrowserLock("setup", () => waitLoginFlow({ timeoutMs: Number(flags.timeout ?? 1800000) }));
  if (!res.ok) {
    if (res.reason === "LOGIN_ABORTED") return emit({ ok: true, loginState: "anonymous", note: "未登录（匿名模式可用）；要解锁视频生成与同步请再跑 cgb login" });
    return fail(res.reason, "等待登录超时，请重试。", res);
  }
  return emit({ ok: true, ...res, browser: br.executablePath ?? br.channel, stateDir: dirs().root });
}

async function cmdLogin() {
  const res = await withBrowserLock("login", () => waitLoginFlow({ timeoutMs: Number(flags.timeout ?? 1800000) }));
  if (!res.ok) return fail(res.reason, "登录未完成，请重试。", res);
  return emit({ ok: true, ...res });
}

async function cmdLogout() {
  const d = dirs();
  for (const target of [d.profile, d.storageState]) {
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      return fail("LOCKED", `清除失败（可能有浏览器仍在运行）：${error.message}`);
    }
  }
  return emit({ ok: true, loggedOut: true, cleared: [d.profile, d.storageState] });
}

/* --------------------------------- doctor --------------------------------- */

async function cmdDoctor() {
  // 只有 --deep 会开浏览器，需要锁；轻量体检直接跑
  return flags.deep ? withBrowserLock("doctor --deep", () => cmdDoctorInner()) : cmdDoctorInner();
}

async function cmdDoctorInner() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: nodeMajor >= 20, detail: process.version });
  checks.push({ name: "deps", ok: depsInstalled(), detail: depsInstalled() ? dirs().deps : "未安装（运行 cgb setup）" });

  const br = findBrowser();
  checks.push({ name: "browser", ok: !!br, detail: br ? br.executablePath ?? `channel=${br.channel}` : "未找到 Chrome / Edge" });

  let stateWritable = true;
  try {
    ensureDir(dirs().root);
    fs.accessSync(dirs().root, fs.constants.W_OK);
  } catch {
    stateWritable = false;
  }
  checks.push({ name: "stateDir", ok: stateWritable, detail: dirs().root });

  let netOk = false;
  let netDetail = "";
  try {
    const res = await fetch("https://www.chatglm.cn/", {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    netOk = res.status > 0;
    netDetail = `HTTP ${res.status}`;
  } catch (error) {
    netDetail = `${error.message}（Node 直连失败；浏览器可能仍可用）`;
    netOk = true;
  }
  checks.push({ name: "network", ok: netOk, detail: netDetail });

  let deep = null;
  if (flags.deep) {
    if (!depsInstalled() || !br) {
      deep = { skipped: true, reason: "DEPENDENCY_MISSING" };
    } else {
      const ctx = await launchBrowser({ headless: !!flags.headless });
      activeCtx = ctx;
      try {
        const page = await collapseToSinglePage(ctx);
        await site.gotoSite(page);
        const st = await site.pageState(page);
        const cookies = await readLoginCookies(ctx);
        const model = await site.readModel(page);
        deep = { state: st, cookies: { total: cookies.total, session: cookies.loginCookies, signedOut: st.signedOut }, model };
        ensureDir(dirs().debug);
        const shot = path.join(dirs().debug, `doctor-${Date.now()}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        deep.screenshot = shot;
        if (flags.html) deep.htmlFile = saveDebugHtml(await page.content(), "doctor");
      } finally {
        await closeBrowser(ctx);
      }
    }
  }

  const cookieCheck = deep?.cookies
    ? {
        name: "login",
        ok: true, // 会话/游客状态不算失败（游客模式可用），只报告
        detail: `${deep.cookies.session?.length ?? 0} 个会话 cookie；${deep.cookies.signedOut ? "游客模式（未登录，登录按钮可见）" : "已登录"}`,
      }
    : null;
  if (cookieCheck) checks.push(cookieCheck);

  let ok = checks.filter((c) => c.name !== "login").every((c) => c.ok);
  let reason;
  if (!ok) {
    const firstBad = checks.find((c) => !c.ok && c.name !== "login")?.name;
    reason = ["deps", "browser"].includes(firstBad) ? "DEPENDENCY_MISSING" : "SEND_FAILED";
  }
  if (deep && !deep.skipped) {
    if (deep.state.challenge) {
      captchaNotice("doctor --deep 真机探测", Number(flags["captcha-wait"] ?? 180000));
      ok = false;
      reason = "HUMAN_VERIFICATION_REQUIRED";
    } else if (deep.state.rateLimited) {
      ok = false;
      reason = "RATE_LIMITED";
    } else if (!deep.state.hasEditor) {
      ok = false;
      reason = "COMPOSER_NOT_FOUND";
    }
    // 未登录不算 doctor 失败（匿名模式可用），login 检查项仅报告状态
  }
  return emit({ ok, checks, reason, deep }, { exitCode: ok ? 0 : 1 });
}

/* ----------------------------------- ask ---------------------------------- */

async function cmdAsk() {
  return withBrowserLock("ask", () => cmdAskInner());
}

async function cmdAskInner() {
  const wsid = workspaceId();
  const session = getSession(wsid);

  let promptText = flags.prompt ?? null;
  if (!promptText && flags["prompt-file"]) {
    try {
      promptText = fs.readFileSync(flags["prompt-file"], "utf8");
    } catch (error) {
      return fail("INVALID_ARGUMENTS", `读不到 --prompt-file：${error.message}`);
    }
  }
  if (!promptText) return fail("INVALID_ARGUMENTS", "缺少 --prompt 或 --prompt-file");

  // 协议封装
  let protocolState = null;
  let taskId = flags.task !== undefined ? String(flags.task) : session.taskId ?? null;
  let iteration = flags.iteration !== undefined ? Number(flags.iteration) : Number(session.iteration) || 0;
  if (flags.protocol !== undefined) {
    if (flags.protocol === true) return fail("INVALID_ARGUMENTS", `--protocol 需要值：${PROTOCOL_STATES.join(" | ")}`);
    protocolState = String(flags.protocol).toUpperCase();
    if (!PROTOCOL_STATES.includes(protocolState)) return fail("INVALID_ARGUMENTS", `--protocol 只接受 ${PROTOCOL_STATES.join(" | ")}`);
    if (!taskId) taskId = newRequestId();
  }

  const gate = sanitizeOutbound(
    protocolState ? buildProtocolMessage(protocolState, promptText, { taskId, iteration }) : promptText,
    { allowSensitive: !!flags["allow-sensitive"], allowLarge: !!flags["allow-large"] }
  );
  if (!gate.ok) return fail(gate.reason, gate.message);
  const subject = gate.text;

  const threadArg = flags.thread === true ? "new" : flags.thread ?? null;
  let targetUrl = site.SITE_URL;
  if (threadArg && threadArg !== "new" && /^https?:/.test(threadArg)) targetUrl = threadArg;
  else if (!threadArg && session.threadUrl) targetUrl = session.threadUrl;

  const requestId = newRequestId();
  const startedAt = Date.now();
  const timeoutMs = Number(flags.timeout ?? 300000);
  const captchaWaitMs = Number(flags["captcha-wait"] ?? 180000);

  let ctx;
  try {
    ctx = await launchBrowser({ headless: !!flags.headless });
    activeCtx = ctx;
  } catch (error) {
    return fail(error.code ?? "DEPENDENCY_MISSING", error.message);
  }

  const downloadsDir = ensureDir(path.join(dirs().downloads, wsid));

  try {
    let page = await collapseToSinglePage(ctx);
    let completion = site.watchCompletion(page);
    let reopened = false; // 是否已经「关闭重开」过 —— 最多一次，防止死循环

    /**
     * 风控恢复（项目规则）：**关闭浏览器再重开**，不是重新登录 ——
     * 登录态随 profile 持久保留，重开后**沿用原来的登录态**继续用
     * （绝不清除登录态 / 绝不清 profile 来"修复"风控，也绝不降级成游客身份）。
     * 仅当重开后发现原登录态确实不在了（登录按钮可见 = 游客态）才停下报错，
     * 让用户自行决定是否 cgb login —— 不在流程里要求重新登录。
     */
    const reopenBrowser = async () => {
      process.stderr.write("按策略关闭浏览器并重开（登录态保留在 profile 中，重开后沿用原登录态）…\n");
      await closeBrowser(ctx);
      activeCtx = null;
      ctx = await launchBrowser({ headless: !!flags.headless });
      activeCtx = ctx;
      page = await collapseToSinglePage(ctx);
      completion = site.watchCompletion(page);
      await site.gotoSite(page, targetUrl);
      const st2 = await site.pageState(page);
      if (st2.challenge) return { challenge: true, state: st2 };
      if (st2.signedOut) {
        return {
          loginLost: true,
          state: st2,
        };
      }
      return { state: st2 };
    };

    /** 原登录态丢失时的统一报错（不允许静默降级成游客身份继续）。 */
    const loginLostFail = (extra) =>
      fail(
        "LOGIN_REQUIRED",
        "重开浏览器后未检测到原登录态（登录按钮可见 = 游客态）。按规则不使用游客身份继续；请先运行 cgb login 重新登录，再重跑本命令。",
        extra
      );

    /* ---------------- 发送前：导航 + 风控门 ---------------- */
    await site.gotoSite(page, targetUrl);
    let st = await site.pageState(page);
    if (st.challenge) {
      captchaNotice("页面加载时触发了访问验证", captchaWaitMs);
      process.stderr.write(
        "   规则：不要反复拖动（智谱风控下真人也常拖不过）。你可以手动拖一次（CLI 不代拖），\n" +
          "   或直接**关闭浏览器窗口** —— CLI 检测到后会自动重开并继续（登录态保留，不走游客身份）；\n" +
          `   超过 ${Math.round(captchaWaitMs / 1000)} 秒未通过也会自动重开。重开最多进行一次。\n`
      );
      const w = await site.waitForChallengeCleared(page, {
        timeoutMs: captchaWaitMs,
        onTick: ({ remainingMs }) =>
          process.stderr.write(`  …仍在等待人工验证，剩余 ${Math.round(remainingMs / 1000)} 秒\n`),
      });
      if (!w.cleared) {
        const r = await reopenBrowser();
        if (r.challenge)
          return fail("HUMAN_VERIFICATION_REQUIRED", "重开浏览器后仍出现访问验证。建议稍等几分钟再试；若登录态已失效，先运行 cgb login。", { state: r.state });
        if (r.loginLost) return loginLostFail({ state: r.state });
        st = r.state;
        reopened = true;
      } else {
        process.stderr.write("✓ 人工验证通过，继续。\n");
        st = await site.pageState(page);
      }
    }
    if (st.rateLimited) return fail("RATE_LIMITED", "智谱清言提示请求过于频繁，请稍后再试。", { retryAfterMs: 300000 });

    let threadLost = false;
    if (!st.hasEditor) {
      if (targetUrl !== site.SITE_URL) {
        threadLost = true;
        await site.gotoSite(page, site.SITE_URL);
        st = await site.pageState(page);
      }
      if (!st.hasEditor) return fail("COMPOSER_NOT_FOUND", "页面上找不到输入框（可能改版）。", { state: st });
    }

    // 开新对话：显式点「新建对话」，避免追加到旧会话
    if (!targetUrl || threadArg === "new") {
      await site.startNewChat(page);
    }

    // 模型只读（智谱清言网页版有模型下拉，但 v1 未接入切换；--model 显式拒绝）
    if (flags.model !== undefined) {
      return fail("INVALID_ARGUMENTS", "chatglm-brain v1 不支持切换模型（页面模型下拉的切换锚点未真机验证）；模型由站点当前选择决定，可用 doctor --deep 查看。");
    }
    const modelBefore = await site.readModel(page);

    // 附件上传。智谱的 input[type=file] **常驻 DOM（隐藏）**，共 3 个：
    // 前两个是图片专用（accept 只有图片扩展名、单选），第三个 accept 为空、multiple=true
    // （「本地文件选择」通用入口）。直接对通用入口 setInputFiles 即可，不必走
    // 「回形针 → 菜单 → 本地文件选择」的 UI 流程。
    if (flags.attach) {
      const files = String(flags.attach).split(",").map((s) => s.trim()).filter(Boolean);
      for (const f of files) {
        if (!fs.existsSync(f)) return fail("INVALID_ARGUMENTS", `附件不存在：${f}`);
      }
      if ((await page.locator('input[type="file"]').count()) === 0) {
        return fail("UPLOAD_REJECTED", "页面上没有文件输入框（可能改版）");
      }
      const general = page.locator('input[type="file"][accept=""]').first();
      const target = (await general.count()) ? general : page.locator('input[type="file"]').last();
      try {
        await target.setInputFiles(files, { timeout: 60000 });
        await page.waitForTimeout(4000);
      } catch (error) {
        return fail("UPLOAD_REJECTED", `附件上传失败：${error.message}`);
      }
    }

    // 发送前记录回答数基线：只认「新增的回答气泡」
    const baseline = await site.snapshotMarkers(page).catch(() => ({ answerCount: 0, markdownCount: 0 }));

    const injected = await site.injectPrompt(page, subject);
    if (!injected.ok) return fail("SEND_FAILED", `输入注入失败（${injected.valueLength}/${injected.expected} 字符）`);

    const sent = await site.sendPrompt(page);
    if (!sent.ok) return fail(sent.reason, sent.message);

    let reSent = false;
    let ans = await site.waitForAnswer(page, {
      timeoutMs,
      completion,
      minAnswers: baseline.answerCount ?? 0,
      minMarkdowns: baseline.markdownCount ?? 0,
      challengeWaitMs: captchaWaitMs,
      onChallenge: ({ phase }) => {
        if (phase === "pending") {
          captchaNotice("发送后触发了访问验证（该消息可能被风控拦截）", captchaWaitMs);
          process.stderr.write(
            "   规则：可手动拖一次（CLI 不代拖），或直接**关闭浏览器窗口** —— CLI 会自动重开并重发（登录态保留）。\n"
          );
        } else if (phase === "cleared") {
          process.stderr.write("✓ 人工验证通过，继续等待回答…\n");
        }
      },
      onPoll: (info) => log("debug", "waitForAnswer poll", info),
    }).catch((e) => ({ ok: false, reason: "INTERNAL_ERROR", message: String(e).slice(0, 200) }));

    // 智谱特性：访问验证会拦住已发出的消息（整页被验证替换）。
    // 验证通过但回答未恢复 → 原地重发一次（completion 必须活着到重发结束）。
    if (ans.reason === "STREAM_STALLED" && ans.challenge && ans.cleared) {
      process.stderr.write("验证通过后回答未恢复（该消息已被打断），正在重发…\n");
      completion.reset();
      await site.startNewChat(page).catch(() => {});
      const inj2 = await site.injectPrompt(page, subject).catch(() => ({ ok: false }));
      if (inj2.ok) {
        const baseline2 = await site.snapshotMarkers(page).catch(() => ({ answerCount: 0, markdownCount: 0 }));
        await site.sendPrompt(page);
        const ans2 = await site.waitForAnswer(page, {
          timeoutMs,
          completion,
          minAnswers: baseline2.answerCount ?? 0,
          minMarkdowns: baseline2.markdownCount ?? 0,
          challengeWaitMs: captchaWaitMs,
          onChallenge: ({ phase }) => {
            if (phase === "pending") captchaNotice("重发时再次触发访问验证", captchaWaitMs);
            else if (phase === "cleared") process.stderr.write("✓ 人工验证通过，继续等待回答…\n");
          },
          onPoll: (info) => log("debug", "waitForAnswer poll(resend)", info),
        }).catch((e) => ({ ok: false, reason: "INTERNAL_ERROR", message: String(e).slice(0, 200) }));
        reSent = true;
        Object.assign(ans, ans2, ans2.ok ? {} : { reSentFailed: true });
      }
    }

    // 风控打断且未通过（等满时限 / 用户关窗）→ 走「关闭重开」恢复并整体重试一次
    if (
      !ans.ok &&
      !ans.text &&
      !reopened &&
      (ans.reason === "HUMAN_VERIFICATION_REQUIRED" || (ans.reason === "BROWSER_CLOSED" && ans.challenge))
    ) {
      const r = await reopenBrowser();
      if (r.challenge)
        return fail("HUMAN_VERIFICATION_REQUIRED", "重开浏览器后仍出现访问验证。建议稍等几分钟再试；若登录态已失效，先运行 cgb login。", { threadUrl: ans.url, state: r.state });
      if (r.loginLost) return loginLostFail({ threadUrl: ans.url, state: r.state });
      reopened = true;
      process.stderr.write("重开完成，重新发送这条消息…\n");
      completion.reset();
      await site.startNewChat(page).catch(() => {});
      const inj3 = await site.injectPrompt(page, subject).catch(() => ({ ok: false }));
      if (inj3.ok) {
        const baseline3 = await site.snapshotMarkers(page).catch(() => ({ answerCount: 0, markdownCount: 0 }));
        await site.sendPrompt(page);
        const ans3 = await site.waitForAnswer(page, {
          timeoutMs,
          completion,
          minAnswers: baseline3.answerCount ?? 0,
          minMarkdowns: baseline3.markdownCount ?? 0,
          challengeWaitMs: captchaWaitMs,
          onChallenge: ({ phase }) => {
            if (phase === "pending") captchaNotice("重开后再次触发访问验证", captchaWaitMs);
            else if (phase === "cleared") process.stderr.write("✓ 人工验证通过，继续等待回答…\n");
          },
          onPoll: (info) => log("debug", "waitForAnswer poll(reopen)", info),
        }).catch((e) => ({ ok: false, reason: "INTERNAL_ERROR", message: String(e).slice(0, 200) }));
        reSent = true;
        Object.assign(ans, ans3, ans3.ok ? {} : { reSentFailed: true });
      }
    }
    completion.dispose();

    if (flags.debug || !ans.ok) {
      const tag = ans.ok ? "ask" : "ask-timeout";
      const file = saveDebugHtml(await page.content(), tag);
      if (!ans.ok) process.stderr.write(`超时取证 HTML：${file}\n`);
      else if (flags.debug) process.stderr.write(`调试 HTML：${file}\n`);
    }

    // 有下载按钮 → 取产物
    let files = [];
    if (ans.downloadLabel) {
      const dl = await site.downloadArtifact(page, ctx, downloadsDir);
      if (dl.ok) files = dl.files;
      log("info", `产物下载: ${JSON.stringify(dl).slice(0, 200)}`);
    }

    if (!ans.ok && !ans.text && !files.length) {
      if (ans.reason === "HUMAN_VERIFICATION_REQUIRED") {
        return fail("HUMAN_VERIFICATION_REQUIRED", captchaFailMessage(captchaWaitMs), {
          threadUrl: ans.url,
          captchaWaitMs,
        });
      }
      if (ans.reason === "BROWSER_CLOSED") {
        return fail("BROWSER_CLOSED", "浏览器窗口被关闭，本次问答中止。重跑同一条命令即可。", { threadUrl: ans.url });
      }
      return fail(ans.reason ?? "STREAM_STALLED", ans.message ?? "等待回答超时，且没有抓到文本或产物。", { threadUrl: ans.url });
    }

    const threadUrl = ans.url && site.CONV_URL_RE.test(ans.url) ? ans.url : session.threadUrl ?? null;
    const protocolReply = protocolState ? parseProtocolReply(ans.text) : null;
    const modelAfter = await site.readModel(page).catch(() => null);
    const patch = { threadUrl, title: session.title ?? null };
    if (protocolState) {
      patch.taskId = taskId;
      patch.iteration = iteration;
      patch.state = protocolReply?.state ?? protocolState;
      const cp = protocolReply ? CHECKPOINT_FOR_REPLY[protocolReply.state] : null;
      if (cp) patch.checkpointPatch = cp;
    } else {
      patch.state = "ANSWERED";
    }
    setSession(patch, wsid);

    appendAudit(
      {
        ts: nowIso(),
        requestId,
        threadUrl,
        model: { requested: flags.model ?? null, before: modelBefore?.current ?? null, after: modelAfter?.current ?? modelBefore?.current ?? null },
        chars: ans.text?.length ?? 0,
        files: files.map((f) => ({ suggested: f.suggested, bytes: f.bytes })),
        protocol: protocolState ? { sent: protocolState, reply: protocolReply?.state ?? null, taskId, iteration } : null,
        truncated: !ans.ok,
        redactions: gate.redactions,
        reSent,
        elapsedMs: Date.now() - startedAt,
      },
      wsid
    );

    return emit({
      ok: true,
      requestId,
      threadUrl,
      modes: { model: modelAfter?.current ?? modelBefore?.current ?? null, requested: flags.model ?? null },
      text: ans.text ?? "",
      files,
      mode: ans.mode ?? (files.length ? "artifact" : "chat"),
      truncated: !ans.ok,
      elapsedMs: ans.elapsedMs ?? Date.now() - startedAt,
      reSent: reSent || undefined,
      threadLost: threadLost || undefined,
      redactions: gate.redactions.length ? gate.redactions : undefined,
      protocol: protocolState ? { sent: protocolState, taskId, iteration, reply: protocolReply } : undefined,
    });
  } finally {
    if (!flags["keep-open"]) await closeBrowser(ctx);
    activeCtx = null;
  }
}

/* -------------------------------- thread / session ------------------------------- */

function cmdThread() {
  const sub = String(positionals[1] ?? "status").toLowerCase();
  const wsid = workspaceId();
  const session = getSession(wsid);
  if (sub === "status" || sub === "list") {
    return emit({ ok: true, workspaceId: wsid, threadUrl: session.threadUrl, title: session.title, state: session.state, checkpoint: session.checkpoint });
  }
  if (sub === "use") {
    const url = flags.url ?? positionals[2];
    if (!url) return fail("INVALID_ARGUMENTS", "用法：cgb thread use <url>");
    return emit({ ok: true, ...setSession({ threadUrl: url }, wsid) });
  }
  if (sub === "new") {
    return emit({ ok: true, ...setSession({ threadUrl: null, state: "NEW" }, wsid), note: "下一条 ask 会从首页开新对话" });
  }
  return fail("INVALID_ARGUMENTS", `未知子命令 thread ${sub}`);
}

function cmdSession() {
  const sub = String(positionals[1] ?? "get").toLowerCase();
  const wsid = workspaceId();
  if (sub === "get") return emit({ ok: true, session: getSession(wsid) });
  if (sub !== "set") return fail("INVALID_ARGUMENTS", `未知子命令 session ${sub}`);

  const patch = {};
  const cp = {};
  if (flags.url !== undefined) patch.threadUrl = flags.url;
  if (flags.title !== undefined) patch.title = flags.title;
  if (flags.task !== undefined) patch.taskId = flags.task;
  if (flags.iteration !== undefined) patch.iteration = Number(flags.iteration);
  if (flags.state !== undefined) patch.state = flags.state;
  if (flags["protocol-state"] !== undefined) cp.protocolState = flags["protocol-state"];
  if (flags["waiting-for"] !== undefined) cp.waitingFor = flags["waiting-for"];
  if (flags["next-step"] !== undefined) cp.nextExpectedStep = flags["next-step"];
  if (flags.goal !== undefined) cp.originalGoal = flags.goal;
  if (flags["known-issues"] !== undefined) cp.knownIssues = flags["known-issues"];
  if (Object.keys(cp).length) patch.checkpointPatch = cp;
  if (flags["clear-checkpoint"]) patch.clearCheckpoint = true;
  if (!Object.keys(patch).length) return fail("INVALID_ARGUMENTS", "没有要写入的字段");

  try {
    return emit({ ok: true, ...setSession(patch, wsid) });
  } catch (error) {
    return fail(error.code ?? "INTERNAL_ERROR", error.message);
  }
}

function cmdLogs() {
  const n = Number(flags.n ?? flags.lines ?? 50);
  const lines = tailLines(Number.isFinite(n) && n > 0 ? n : 50, { verbose: !!flags.verbose });
  if (json) return emit({ ok: true, lines });
  process.stdout.write(`${lines.join("\n")}\n`);
  return { ok: true };
}

function cmdUpdateCheck() {
  const d = dirs();
  const cache = readJson(d.updateCheck) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  if (!flags.force && cache.checkedOn === today) {
    return emit({ ok: true, version: VERSION, checked: false, updateAvailable: cache.updateAvailable ?? false, note: "今日已检查（缓存）" });
  }
  const note = "未配置远端仓库（git remote），无法自动检查更新；更新方式见 references/install.md";
  writeJson(d.updateCheck, { checkedOn: today, updateAvailable: false, note });
  return emit({ ok: true, version: VERSION, checked: true, updateAvailable: false, note });
}

/** 读取当前模型（智谱清言 v1 只读，不切换） */
async function cmdListModels() {
  return withBrowserLock("list-models", () => cmdListModelsInner());
}

async function cmdListModelsInner() {
  let ctx;
  try {
    ctx = await launchBrowser({ headless: !!flags.headless });
    activeCtx = ctx;
  } catch (error) {
    return fail(error.code ?? "DEPENDENCY_MISSING", error.message);
  }
  try {
    const page = await collapseToSinglePage(ctx);
    await site.gotoSite(page);
    const model = await site.readModel(page);
    if (!model?.current) return fail("SITE_CHANGED", "未读到当前模型（composer 内无 GLM 文案锚点）");
    return emit({
      ok: true,
      current: model.current,
      options: [model.current],
      note: "智谱清言 v1 只读当前模型、不支持切换（模型下拉的切换锚点未真机验证）；底层模型由站点当前选择决定。",
    });
  } finally {
    await closeBrowser(ctx);
  }
}

function usage() {
  process.stdout.write(`cgb ${VERSION} — chatglm-brain 机制层

用法：node <skill-root>/scripts/cgb/cli.mjs <命令> [选项]

命令：
  setup                 首次配置：装依赖 → 打开浏览器 → 人工登录（可跳过，匿名可用）
  login / logout        重新登录 / 清除登录态
  doctor [--deep] [--html]   体检（--deep 真机探测页面与模式选择器）
  ask --prompt-file f [--attach a.png] [--thread new|<url>] [--json]
  list-models           读取当前模型（v1 只读，不切换）
  thread status|use <url>|new
  session get|set [...]      工作区线程与 checkpoint
  logs [-n 50] [--verbose]
  update-check [--force]

通用：--json 机器可读；--debug 保存页面 HTML；--keep-open 保留浏览器窗口；
     --captcha-wait <ms> 人机验证等待时限（默认 180000）
`);
  return { ok: true };
}

/* --------------------------------- dispatch --------------------------------- */

try {
  if (flags.version) emit({ ok: true, version: VERSION });
  else if (cmd === "setup") await cmdSetup();
  else if (cmd === "login") await cmdLogin();
  else if (cmd === "logout") await cmdLogout();
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "ask") await cmdAsk();
  else if (cmd === "list-models") await cmdListModels();
  else if (cmd === "thread") cmdThread();
  else if (cmd === "session") cmdSession();
  else if (cmd === "logs") cmdLogs();
  else if (cmd === "update-check") cmdUpdateCheck();
  else usage();
} catch (error) {
  fail(error.code ?? "INTERNAL_ERROR", error.message ?? String(error));
}
