import fs from "node:fs";
import path from "node:path";

/**
 * metaso.cn（秘塔AI搜索）页面交互层
 *
 * 所有选择器均来自真机验证（2026-09），完整记录见 references/site-map.md。
 * 与同族 brain 的关键差异：
 *   - 首页 composer 是**真 textarea**（React 受控，MUI）：原型 value setter + input 事件注入
 *   - 发送方式是 **Enter**（placeholder 自述「Enter键发送，Shift+Enter键换行」），
 *     页面没有独立的发送按钮 —— 不需要坐标点击
 *   - 强度档位（简洁/深入/深度研究）是 MUI 分段控件，**data-testid 锚点稳定**（ModelTab.MetaButton.N），
 *     选中态类名含 `meta-model-tab_active`；默认档是「深入」，**可以切换**（v1 真机验证）
 *   - 发送后 SPA 跳转到 `metaso.cn/chat/<雪花id>`；回答流式渲染进 `.markdown-body`（与智谱同款类名）
 *   - 网络端点：POST /api/search-result（检索）+ POST /api/search/chat（流式回答）；
 *     游客登录态可页内 GET /api/my-info 探测（游客返回 errCode:401）
 *   - 正文引用角标是 span.reference-num（class 含 reference-dot）；右侧有来源面板
 *   - class 大量带 CSS-Modules 哈希后缀（__kjgyz / __0Dldr），锚点一律用 [class*=前缀] 或 data-testid
 */

export const SITE_URL = "https://metaso.cn/";

/** 会话 URL：https://metaso.cn/chat/<雪花id>（v2 路由 /search/<id> 也认）。
 * ⚠️ 未登录触发登录墙的流程里会出现 `chat/temp-<uuid>` 形态（实测 2026-09-12：
 * 深度研究游客开跑后先给 temp 会话、随即弹登录墙），一并匹配以便如实上报。 */
export const CONV_URL_RE = /metaso\.cn\/(?:chat|search)\/(?:temp-[0-9a-f-]{10,}|\d{6,})/i;

/** 搜索/回答请求端点（完成判定的网络信号；真机验证 2026-09） */
export const COMPLETION_URL_PARTS = ["/api/search-result", "/api/search/chat"];

/** 强度档位（首页分段控件，data-testid=ModelTab.MetaButton.0/1/2 一一对应） */
export const INTENSITIES = ["简洁", "深入", "深度研究"];

export const LABELS = {
  editor: "composer 的 textarea（首页 placeholder=请输入…；结果页 placeholder=请输入您的问题）",
  send: "无发送按钮，Enter 发送",
  newChat: "无（回主页即新搜索，startNewChat 用导航实现）",
  intensity: "首页 meta-model-tab 分段控件（简洁/深入/深度研究）",
  attach: "首页「上传文件」入口（v1 未自动化）",
};

export async function gotoSite(page, url = SITE_URL, { readyTimeoutMs = 25000 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  // SPA 水合需要时间：轮询等编辑器挂载（固定 sleep 会拿空页面）
  const started = Date.now();
  while (Date.now() - started < readyTimeoutMs) {
    const st = await page.evaluate(STATE_FN).catch(() => null);
    if (st?.hasEditor || st?.challenge) return st;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500);
  return page.evaluate(STATE_FN).catch(() => null);
}

/* --------------------------------- 状态探测 --------------------------------- */

export const STATE_FN = () => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true";
  const body = document.body ? document.body.innerText || "" : "";
  const ta = [...document.querySelectorAll("textarea")].filter(vis);
  // ⚠️ 游客与登录的界面判据：左上角「登录/注册」按钮（游客可见，登录后消失）。
  //   文案里带斜杠，必须整体匹配「登录/注册」，避免误伤页面里其他含「登录」的文案
  const signIn = [...document.querySelectorAll("button,a,div,span")]
    .filter((e) => e.getClientRects().length > 0 && e.children.length === 0)
    .some((e) => /^登录\s*\/\s*注册$/.test((e.innerText || "").trim()));
  // 登录墙/额度墙（游客额度用尽或功能需要登录时弹出；文案为保守集合，避免误伤）
  const loginWallHit = body.match(
    /.{0,40}(请先登录|登录后继续|登录后即可|登录后可(继续|使用|查看)|免费次数已用完|(今日|每天).{0,6}(额度|次数).{0,4}(已|用).{0,4}(完|上限)|额度已用完).{0,40}/i
  );
  // 限流/频率提示（站点用瞬时 toast 提示，页面快照里通常已消失 —— 必须把命中文案带出来）
  const rateLimitedHit = body.match(/.{0,40}(请求过于频繁|操作过于频繁|稍后再试|访问异常|rate limit).{0,40}/i);
  return {
    url: location.href,
    title: document.title,
    hasEditor: ta.length > 0,
    editorCount: ta.length,
    // 游客也有会话 cookie，登录态判定靠这个（登录/注册按钮是否可见），不能只看 cookie
    signedOut: signIn,
    challenge:
      /访问验证|人机验证|安全验证|请按住滑块|拖动滑块|拖动到最右边|验证码/i.test(body.slice(0, 3000)),
    // 命中时带上下文片段，便于诊断（实测：游客点深度研究弹「登录后继续搜索」）
    loginWall: !!loginWallHit,
    loginWallText: loginWallHit ? loginWallHit[0].replace(/\s+/g, " ").trim().slice(0, 120) : null,
    rateLimited: !!rateLimitedHit,
    rateLimitedText: rateLimitedHit ? rateLimitedHit[0].replace(/\s+/g, " ").trim().slice(0, 120) : null,
    consent: false,
    textSample: body.replace(/\s+/g, " ").trim().slice(0, 240),
  };
};

export async function pageState(page) {
  return page.evaluate(STATE_FN);
}

/** 等输入框就绪 */
export async function waitForEditor(page, { timeoutMs = 1800000, pollMs = 3000, onTick } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(STATE_FN).catch(() => null);
    if (last?.hasEditor) return { ok: true, state: last };
    onTick?.(last, Date.now() - started);
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, state: last };
}

/* --------------------------------- 强度档位 --------------------------------- */

/**
 * 读取当前强度档位：首页分段控件选中态（class 含 meta-model-tab_active）。
 * ⚠️ 只有首页有该控件；结果页追问视图没有 → 返回 null（不是错误）。
 */
export async function readIntensity(page) {
  return page.evaluate(() => {
    const active = [...document.querySelectorAll("button")].find((b) =>
      /meta-model-tab_active/.test(typeof b.className === "string" ? b.className : "")
    );
    if (!active) return null;
    const raw = (active.innerText || "").replace(/\s+/g, "").trim();
    return { raw, current: raw || null };
  });
}

/**
 * 带重试的档位读取。首页水合时 composer 先挂载、左侧菜单与档位控件后挂载
 * （doctor --deep / ask / list-models 实测都踩过：ready 即读拿到 null）。
 * 结果页没有该控件 → 整个重试窗口结束后返回 null（不是错误）。
 */
export async function readIntensityStable(page, { timeoutMs = 8000, pollMs = 600 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readIntensity(page).catch(() => null);
    if (last?.current) return last;
    await page.waitForTimeout(pollMs);
  }
  return last;
}

/**
 * 切换强度档位：按 data-testid=ModelTab.MetaButton.<index> 点击（0=简洁 1=深入 2=深度研究）。
 * 真机验证 2026-09：点击「深入」后选中态类正确移动。
 * ⚠️ 首页水合时 composer 先挂载、左侧菜单与档位控件后挂载（doctor --deep 实测：
 *    ready 即读会拿到 intensity:null），所以这里带重试轮询等控件出现。
 * 深度研究的子选项（先想后搜/先搜后扩）v1 不自动化，用站点默认子选项。
 */
export async function setIntensity(page, name, { timeoutMs = 8000, pollMs = 500 } = {}) {
  const idx = INTENSITIES.indexOf(name);
  if (idx < 0) return { ok: false, reason: "INVALID_ARGUMENTS", message: `未知强度档位：${name}` };
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    const clicked = await page.evaluate((i) => {
      const btn = [...document.querySelectorAll("button[data-testid^='ModelTab.MetaButton.']")].find(
        (b) => (b.getAttribute("data-testid") || "").endsWith(`.${i}`)
      );
      if (!btn) return false;
      btn.click();
      return true;
    }, idx);
    if (clicked) {
      await page.waitForTimeout(900);
      const cur = await readIntensity(page).catch(() => null);
      if (!cur?.current) return { ok: false, reason: "SITE_CHANGED", message: "点击后未读到选中态（可能改版）" };
      if (cur.current !== name) return { ok: false, reason: "SEND_FAILED", message: `档位切换未生效（当前 ${cur.current}，期望 ${name}）` };
      return { ok: true, current: cur.current };
    }
    lastError = "TABS_NOT_FOUND";
    await page.waitForTimeout(pollMs);
  }
  return {
    ok: false,
    reason: lastError,
    message: "页面上没有强度档位分段控件（结果页追问视图没有该控件；新搜索请加 --thread new）",
  };
}

/**
 * 页内探测登录态（供 doctor --deep / 登录流程 / 风控恢复使用）。
 * ⚠️ 这是 metaso 登录态的**主判据**：metaso 自己的 /api/my-info，
 *    游客态返回 `{errCode:401, errMsg:"需要登录"}`（真机验证 2026-09）。
 * 界面判据（「登录/注册」按钮）只做兜底 —— 左侧菜单水合慢，ready 即读会误判。
 */
export const MY_INFO_FN = async () => {
  try {
    const r = await fetch("/api/my-info", { credentials: "include" });
    const j = await r.json().catch(() => null);
    return { status: r.status, errCode: j?.errCode ?? null, errMsg: j?.errMsg ?? null };
  } catch (error) {
    return { error: String(error).slice(0, 120) };
  }
};

export async function probeLogin(page) {
  const myInfo = await page.evaluate(MY_INFO_FN).catch(() => null);
  if (!myInfo || myInfo.error) return { unknown: true, myInfo };
  return { guest: !!myInfo.errCode, errCode: myInfo.errCode ?? null, myInfo };
}

/* --------------------------------- 输入与发送 -------------------------------- */

/**
 * 注入 prompt。
 * 输入框是 React 受控 textarea（MUI）：必须用 HTMLTextAreaElement 原型上的
 * 原生 value setter + input 事件；直接赋值 `ta.value = x` 不触发 React 更新。
 * 页面上同时只有一个可见 textarea（首页 1 个 / 结果页追问框 1 个），取第一个即可。
 * 支持多行文本（value 里带 \n 即可；metaso 明确支持 Shift+Enter 换行、Enter 整体发送）。
 */
export async function injectPrompt(page, text) {
  const ta = page.locator("textarea").first();
  await ta.waitFor({ state: "visible", timeout: 25000 });
  await ta.click({ timeout: 15000 });
  await page.waitForTimeout(300);

  const res = await page.evaluate((value) => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const el = [...document.querySelectorAll("textarea")].find(vis);
    if (!el) return { ok: false, len: 0 };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, len: (el.value || "").length };
  }, text);
  await page.waitForTimeout(600);
  const finalLen = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const el = [...document.querySelectorAll("textarea")].find(vis);
    return (el?.value || "").length;
  });
  return { ok: finalLen > 0, valueLength: finalLen, expected: text.length };
}

/**
 * 发送：metaso 的 composer 自述「Enter键发送」——聚焦输入框后按 Enter 即可，
 * 页面没有独立发送按钮（真机验证 2026-09：Enter 成功触发搜索并跳转 /chat/<id>）。
 * 多行 prompt 也没问题：value 里的换行只是内容，Enter 键才触发发送。
 */
export async function sendPrompt(page) {
  const focused = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const el = [...document.querySelectorAll("textarea")].find(vis);
    if (!el) return false;
    el.focus();
    return true;
  });
  if (!focused) return { ok: false, reason: "COMPOSER_NOT_FOUND", message: "页面上没有可见输入框" };
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  return { ok: true, method: "enter" };
}

/* ---------------------------------- 完成判定 --------------------------------- */

/**
 * 监听生成请求。metaso 一次搜索会先后打两个端点：
 *   POST /api/search-result（检索来源）→ POST /api/search/chat（流式回答）。
 * 用计数而不是单布尔：seen 里所有请求都结束才算 netIdle，
 * 避免第一个请求先结束就把闸门提前放行（cgb 单布尔实现的隐患）。
 * 一个端点都没见到时视为 netIdle（兜底走文本稳定判定）。
 */
export function watchCompletion(page, urlParts = COMPLETION_URL_PARTS) {
  const state = { seen: 0, done: 0, failed: 0 };
  const match = (req) => urlParts.some((p) => req.url().includes(p));
  const onRequest = (req) => match(req) && state.seen++;
  const onFinished = (req) => match(req) && state.done++;
  const onFailed = (req) => match(req) && state.failed++;
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  return {
    get state() {
      return { ...state };
    },
    /** 全部已结束（或一个都没见到）→ true */
    get netIdle() {
      return state.seen === 0 || state.seen <= state.done + state.failed;
    },
    reset() {
      state.seen = 0;
      state.done = 0;
      state.failed = 0;
    },
    dispose() {
      page.off("request", onRequest);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    },
  };
}

/**
 * 回答区状态（真机验证 2026-09）：
 *   - 正文：`.markdown-body`（每轮回答一个；发送前的基线计数用于只认新增）
 *   - 引用角标：class 含 `reference-dot` 的 span（正文内联引用点数）
 *   - 来源标题：右侧来源面板（class 含 search-origin-box 的容器内的 contentContainer 卡片）
 *   - 思考标记：data-testid=ReasoningView.MotionMetaBtn.思考了（「思考了X.XXs」）
 */
export const EXTRACT_FN = () => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true";
  const clean = (s) =>
    (s || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const collectText = (node) => {
    let out = "";
    const BLOCK = /^(p|div|li|tr|h[1-6]|pre|blockquote|section|article|table|ul|ol)$/;
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style") continue;
      if (tag === "sup" || tag === "sub") {
        out += collectText(el);
        continue;
      }
      if (tag === "br") {
        out += "\n";
        continue;
      }
      if (tag === "tr") out += "\n";
      if (tag === "td" || tag === "th") out += " | ";
      const isBlock = BLOCK.test(tag);
      if (isBlock) out += "\n";
      out += collectText(el);
      if (isBlock) out += "\n";
    }
    return out;
  };

  const mds = [...document.querySelectorAll(".markdown-body")].filter(vis);
  const lastMd = mds[mds.length - 1] ?? null;
  const text = lastMd ? clean(collectText(lastMd)) : "";

  // 来源标题卡（右侧面板）；拿不到就给空列表 —— 不算失败
  const originBox = document.querySelector('[class*="search-origin-box"]');
  const sourceTitles = originBox
    ? [...originBox.querySelectorAll('[class*="contentContainer"]')]
        .filter(vis)
        .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
        .filter((t) => t && t.length <= 120)
        .slice(0, 20)
    : [];

  const stopVisible = [...document.querySelectorAll("div,button,span")].some(
    (el) => el.children.length === 0 && /^(停止|停止生成|Stop)$/.test((el.textContent || "").trim()) && el.getClientRects().length > 0
  );

  const bodyText = document.body.innerText || "";
  return {
    text,
    textLen: text.length,
    answerCount: mds.length,
    markdownCount: mds.length,
    referenceCount: document.querySelectorAll('[class*="reference-dot"]').length,
    sourceTitles,
    stopVisible,
    isStreaming: stopVisible,
    thinking: /思考了\s*[\d.]+s/.test(bodyText),
    url: location.href,
  };
};

export async function snapshotMarkers(page) {
  try {
    return await page.evaluate(EXTRACT_FN);
  } catch {
    return { text: "", textLen: 0, answerCount: 0, markdownCount: 0, stopVisible: false, referenceCount: 0, sourceTitles: [] };
  }
}

/**
 * 等本次回答完成：网络结束 + 文本连续 N 次采样不变 + 只认新增回答。
 * minAnswers / minMarkdowns：发送前的基线（页面会恢复最近会话，必须只认新增）。
 *
 * 页面被登录墙 / 限流文案接管时要立刻返回对应失败码；
 * 人机验证（challenge）的三种状态与 cgb 同构：
 *   1. 等用户完成验证期间 —— 回答超时时钟暂停；
 *   2. 验证通过后 —— 只给 challengeGraceMs 宽限，仍无新增正文就返回 STREAM_STALLED + cleared；
 *   3. 一直没完成 —— 超过 challengeWaitMs 返回 HUMAN_VERIFICATION_REQUIRED。
 * 页面/浏览器被用户关闭 → reason:"BROWSER_CLOSED"。
 */
export async function waitForAnswer(
  page,
  {
    timeoutMs = 300000,
    pollMs = 2000,
    stableSamples = 3,
    completion = null,
    minAnswers = 0,
    minMarkdowns = 0,
    challengeWaitMs = 180000,
    challengeGraceMs = 15000,
    onPoll,
    onChallenge,
  } = {}
) {
  const started = Date.now();
  let pausedMs = 0;
  let challengeStartedAt = null;
  let challengeClearedAt = null;
  let challengeSeen = false;
  let last = "";
  let stable = 0;
  let lastState = null;
  const activeElapsed = () => Date.now() - started - pausedMs;

  const evalOrNull = async (fn) => {
    try {
      return await page.evaluate(fn);
    } catch (error) {
      if (/has been closed|Target closed|Target page, context or browser/i.test(String(error))) {
        return { __closed: true };
      }
      return null;
    }
  };

  while (activeElapsed() < timeoutMs) {
    const stNow = await evalOrNull(STATE_FN);
    if (stNow?.__closed) return { ok: false, reason: "BROWSER_CLOSED", elapsedMs: activeElapsed() };
    if (stNow?.challenge) {
      if (!challengeSeen) {
        challengeSeen = true;
        challengeStartedAt = Date.now();
        onChallenge?.({ phase: "pending" });
      }
      if (Date.now() - challengeStartedAt > challengeWaitMs) {
        return {
          ok: false,
          reason: "HUMAN_VERIFICATION_REQUIRED",
          challenge: true,
          pending: true,
          ...(lastState ?? {}),
          elapsedMs: activeElapsed(),
        };
      }
      onPoll?.({ challenge: true });
      await page.waitForTimeout(pollMs).catch(() => {});
      continue;
    }
    if (stNow?.loginWall && !(lastState?.textLen > 0)) {
      return { ok: false, reason: "LOGIN_REQUIRED", loginWall: true, state: stNow, elapsedMs: activeElapsed() };
    }
    if (stNow?.rateLimited && !(lastState?.textLen > 0)) {
      return { ok: false, reason: "RATE_LIMITED", state: stNow, elapsedMs: activeElapsed() };
    }

    if (challengeStartedAt && challengeClearedAt === null) {
      challengeClearedAt = Date.now();
      pausedMs += challengeClearedAt - challengeStartedAt; // 等待用户完成验证的时间不计入回答超时
      onChallenge?.({ phase: "cleared" });
    }

    lastState = await evalOrNull(EXTRACT_FN);
    if (lastState?.__closed) return { ok: false, reason: "BROWSER_CLOSED", elapsedMs: activeElapsed() };
    const cs = completion?.state ?? { seen: 0, done: 0, failed: 0 };
    const netIdle = completion ? completion.netIdle : true;

    if (lastState) {
      const fresh =
        (lastState.answerCount ?? 0) > minAnswers || (lastState.markdownCount ?? 0) > minMarkdowns;
      const t = fresh ? lastState.text ?? "" : "";
      if (netIdle && t.length > 0 && t === last) stable++;
      else stable = 0;
      last = t;

      onPoll?.({
        len: t.length,
        stable,
        fresh,
        net: `${cs.seen}seen/${cs.done}done/${cs.failed}failed`,
        streaming: lastState.stopVisible,
        challenge: challengeClearedAt ? "cleared" : undefined,
      });

      // 验证通过后仍拿不到新增正文（消息已被拦）→ 立刻交给上层重发
      if (challengeClearedAt && t.length === 0 && Date.now() - challengeClearedAt > challengeGraceMs) {
        return {
          ok: false,
          reason: "STREAM_STALLED",
          challenge: true,
          cleared: true,
          ...lastState,
          elapsedMs: activeElapsed(),
        };
      }

      if (fresh && netIdle && t.length > 0 && stable >= stableSamples) {
        return { ok: true, ...lastState, mode: "chat", elapsedMs: activeElapsed() };
      }
      if (fresh && netIdle && !lastState.stopVisible && activeElapsed() > 20000 && stable >= 2) {
        return { ok: true, ...lastState, mode: "chat", elapsedMs: activeElapsed() };
      }
    }
    await page.waitForTimeout(pollMs).catch(() => {});
  }
  return {
    ok: false,
    reason: "STREAM_STALLED",
    ...(lastState ?? {}),
    challenge: challengeSeen || undefined,
    cleared: challengeClearedAt ? true : undefined,
    elapsedMs: activeElapsed(),
  };
}

/**
 * 开新搜索：metaso 没有独立「新对话」按钮，回主页就是新搜索。
 * 已在主页时不再重复导航（省一次水合）。
 */
export async function startNewChat(page) {
  const path = (() => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return "/";
    }
  })();
  if (path === "/" || path === "") return { clicked: false, method: "already-home" };
  await page.goto(SITE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  return { clicked: true, method: "goto-home" };
}

/**
 * 等滑块/人机验证消失（用户在浏览器里完成）。
 * onWait：首次检测到验证时回调；onTick：每 ~20 秒回调一次（播报剩余等待时间）。
 * 用户中途关掉浏览器 → `{ cleared:false, aborted:true }`。
 */
export async function waitForChallengeCleared(page, { timeoutMs = 300000, pollMs = 3000, onWait, onTick } = {}) {
  const started = Date.now();
  let first = true;
  let lastTick = 0;
  while (Date.now() - started < timeoutMs) {
    let st = null;
    try {
      st = await page.evaluate(STATE_FN);
    } catch {
      return { cleared: false, aborted: true, waitedMs: Date.now() - started };
    }
    if (!st?.challenge) return { cleared: true, waitedMs: Date.now() - started };
    const elapsed = Date.now() - started;
    if (first) {
      first = false;
      onWait?.({ timeoutMs });
    }
    const sec = Math.round(elapsed / 1000);
    if (sec - lastTick >= 20) {
      lastTick = sec;
      onTick?.({ elapsedMs: elapsed, remainingMs: timeoutMs - elapsed });
    }
    try {
      await page.waitForTimeout(pollMs);
    } catch {
      return { cleared: false, aborted: true, waitedMs: Date.now() - started };
    }
  }
  return { cleared: false, waitedMs: Date.now() - started };
}

/** metaso v1 没有可下载产物（幻灯片/海报在页内展示，不提供 CLI 下载）——占位保持接口同构。 */
export async function downloadArtifact() {
  return { ok: false, reason: "NOT_FOUND", message: "metaso v1 无产物下载（幻灯片/海报/脑图在页内查看）" };
}

/* ------------------------------- 会话元数据 API ------------------------------ */

/**
 * 拉取当前会话的结构化元数据（真机验证 2026-09-12）：
 *   GET /api/conversation/<convId>/branched-messages
 * ASSISTANT 消息里直接带：
 *   - `citation[]`：完整引用（**link / title / site / date / snippet** 全有，无需二次请求）
 *   - `totalCiteNum`：正文引用角标总数（页面「思考了Xs」旁那个数字）
 *   - `mode` / `model`：服务端实际生效的档位与内部模型名（如 concise / fast_thinking）
 * convId 取自页面 URL（/chat/<id>）；首页（无会话）返回 null。
 * 这是只读 GET，不消耗搜索额度。
 */
export const THREAD_META_FN = async (convId) => {
  try {
    const r = await fetch(`/api/conversation/${convId}/branched-messages`, { credentials: "include" });
    const j = await r.json().catch(() => null);
    const msgs = j?.data?.activePathMessages;
    if (!Array.isArray(msgs) || msgs.length === 0) return { ok: false, reason: "NO_MESSAGES" };
    const asst = [...msgs].reverse().find((m) => m.role === "ASSISTANT");
    if (!asst) return { ok: false, reason: "NO_ASSISTANT" };
    const cites = Array.isArray(asst.citation) ? asst.citation : [];
    // citation[] 是「每个引用角标一条」（实测深度研究 159 条、同一来源重复出现），
    // sources 按 url/title 去重后给出唯一样本，避免把 20 条重复塞给调用方
    const seen = new Set();
    const sources = [];
    for (const c of cites) {
      const key = (c.link || c.title || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      sources.push({
        title: (c.title || c.orig_o_title || "").trim(),
        url: c.link ?? null,
        site: c.site ?? null,
        date: c.date ?? null,
      });
      if (sources.length >= 20) break;
    }
    return {
      ok: true,
      serverMode: asst.mode ?? null,
      serverModel: asst.model ?? null,
      totalCiteNum: asst.totalCiteNum ?? null,
      sources,
    };
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 120) };
  }
};

export async function fetchThreadMeta(page) {
  const convId = await page.evaluate(() => {
    const m = location.pathname.match(/\/(?:chat|search)\/(\d+)/);
    return m ? m[1] : null;
  });
  if (!convId) return null;
  const meta = await page.evaluate(THREAD_META_FN, convId).catch(() => null);
  return meta ? { convId, ...meta } : null;
}
