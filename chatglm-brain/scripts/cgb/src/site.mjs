import fs from "node:fs";
import path from "node:path";

/**
 * chatglm.cn（智谱清言）页面交互层
 *
 * 所有选择器均来自真机验证（2026-09），完整记录见 references/site-map.md。
 * 与同族 brain 的关键差异：
 *   - 输入框是**真 textarea**（React 受控）：用原型 value setter + input 事件注入
 *   - 发送按钮不是 button，是 composer 内 class 含 `enter` 的 div（圆形图标）
 *   - class 是语义化命名（markdown-body / answer-content），无随机后缀
 *   - 会话 URL 用 **cid 查询参数**（?...&cid=<24hex>），不是路径段
 *   - 游客也会拿到 chatglm_token cookie：**cookie 无法区分游客/登录**，
 *     登录判定必须看「登录按钮是否可见」
 *   - 回答末尾带推荐问题（在 markdown-body 之外，不会混入正文，但注意别抓错容器）
 */

export const SITE_URL = "https://chatglm.cn/";

/** 会话 URL：https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=<24位十六进制> */
export const CONV_URL_RE = /chatglm\.cn\/main\/[^\s]*cid=[0-9a-f]{12,}/i;

/** 生成请求端点（完成判定的网络信号；真机验证 2026-09） */
export const COMPLETION_URL_PARTS = ["/backend-api/assistant/stream"];

export const LABELS = {
  editor: "composer 的 textarea",
  send: "composer 内 div.enter（圆形发送图标）",
  newChat: "新对话",
  model: "composer 内「GLM-Flash 极致」文字按钮（v1 只读）",
  attach: "composer 内回形针图标",
};

export async function gotoSite(page, url = SITE_URL, { readyTimeoutMs = 25000 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  // 首页会重定向到 /main/alltoolsdetail；轮询等编辑器挂载（SPA 水合慢，固定 sleep 会拿空页面）
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
  const vis = (el) =>
    !!el && el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true";
  const body = document.body ? document.body.innerText || "" : "";
  const ta = [...document.querySelectorAll("textarea")].filter(vis);
  // ⚠️ 登录按钮是 div.sidebar-user-entry，innerText 为两行拼接
  //   （「登录⏎登录送积分好礼」，去空白后是「登录登录送积分好礼」）——
  //   必须去空白后用正则匹配，精确等值会漏、游客会被误判成已登录（实测踩过）
  const signIn = [...document.querySelectorAll("button,a,div")]
    .filter((e) => e.getClientRects().length > 0)
    .some((e) => /^登录(登录)?(送积分好礼)?$/.test((e.innerText || "").replace(/\s+/g, "")));
  return {
    url: location.href,
    title: document.title,
    hasEditor: ta.length > 0,
    editorCount: ta.length,
    // ⚠️ 游客也有会话 cookie，登录态判定靠这个（登录按钮是否可见），不能只看 cookie
    signedOut: signIn,
    challenge:
      /访问验证|请按住滑块|拖动到最右边|别离开，为了更好的访问体验|请拖动下方滑块完成验证|人机验证/i.test(body.slice(0, 3000)),
    rateLimited: /请求过于频繁|稍后再试|已达到上限|今日额度|额度已用完|rate limit/i.test(body),
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

/* --------------------------------- 输入与发送 -------------------------------- */

/**
 * 注入 prompt。
 * 输入框是 React 受控 textarea：必须用 HTMLTextAreaElement 原型上的
 * 原生 value setter + input 事件；直接赋值 `ta.value = x` 不触发 React 更新。
 * 支持多行文本（value 里带 \n 即可，不会触发发送）。
 */
export async function injectPrompt(page, text) {
  const ta = page.locator("textarea").first();
  await ta.waitFor({ state: "visible", timeout: 25000 });
  await ta.click({ timeout: 15000 });
  await page.waitForTimeout(300);

  const res = await page.evaluate((value) => {
    const el = document.querySelector("textarea");
    if (!el) return { ok: false, len: 0 };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, len: (el.value || "").length };
  }, text);
  await page.waitForTimeout(600);
  const finalLen = await page.evaluate(() => (document.querySelector("textarea")?.value || "").length);
  return { ok: finalLen > 0, valueLength: finalLen, expected: text.length };
}

/**
 * 定位发送按钮：composer 容器（textarea 的祖先）内 24–60px 的可点元素，
 * 优先 class 含 `enter` 且不含 `center`（真机验证：发送图标是 div.enter.is-main-chat），
 * 否则取最靠右的候选。
 */
const FIND_SEND_FN = () => {
  const vis = (e) => !!e && e.getClientRects().length > 0 && e.getAttribute("aria-hidden") !== "true";
  const ta = document.querySelector("textarea");
  if (!ta) return null;
  let box = ta;
  for (let i = 0; i < 8 && box; i++) {
    if (box.getBoundingClientRect().height > 80) break;
    box = box.parentElement;
  }
  if (!box) return null;
  const all = [...box.querySelectorAll("*")].filter(vis);
  const sized = all.filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width >= 24 && r.width <= 60 && r.height >= 24 && r.height <= 60;
  });
  const withCls = sized.filter((e) => {
    const c = typeof e.className === "string" ? e.className : "";
    return /(^|\s)enter(\s|$)|enter[\s-]/i.test(c) && !/center/i.test(c);
  });
  const pool = withCls.length ? withCls : sized;
  pool.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
  const btn = pool[0];
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { cls: typeof btn.className === "string" ? btn.className.slice(0, 80) : "", x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
};

/**
 * 发送：优先坐标点击发送图标（**多行 prompt 不能用 Enter**——textarea 里 Enter 是换行，
 * 会把 prompt 拦腰发出，实测多行注入后必须点按钮）；按钮找不到时兜底 Enter（单行可用）。
 */
export async function sendPrompt(page) {
  const btn = await page.evaluate(FIND_SEND_FN);
  if (btn) {
    await page.mouse.click(btn.x, btn.y);
    await page.waitForTimeout(1500);
    return { ok: true, method: "send-icon", detail: btn.cls };
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  return { ok: true, method: "enter-fallback" };
}

/* ---------------------------------- 模型读取 --------------------------------- */

/**
 * 读取当前模型：composer 容器内含「GLM-」文案的最小可见元素（如「GLM-Flash 极致」）。
 * ⚠️ v1 只读不切：模型下拉菜单的稳定锚点未真机验证，不要猜选择器（见 site-map.md）。
 */
export async function readModel(page) {
  return page.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0;
    const ta = document.querySelector("textarea");
    if (!ta) return null;
    let box = ta;
    for (let i = 0; i < 8 && box; i++) {
      if (box.getBoundingClientRect().height > 80) break;
      box = box.parentElement;
    }
    if (!box) return null;
    const all = [...box.querySelectorAll("div,span,button")].filter(vis).filter((e) => /GLM/i.test(e.innerText || ""));
    all.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    const el = all[0];
    if (!el) return null;
    const raw = (el.innerText || "").replace(/\s+/g, " ").trim();
    return { raw, current: raw || null };
  });
}

/* ---------------------------------- 完成判定 --------------------------------- */

/** 监听生成请求（主判据：POST /backend-api/assistant/stream 结束） */
export function watchCompletion(page, urlParts = COMPLETION_URL_PARTS) {
  const state = { seen: false, done: false, failed: false };
  const match = (req) => urlParts.some((p) => req.url().includes(p));
  const onRequest = (req) => match(req) && (state.seen = true);
  const onFinished = (req) => match(req) && (state.done = true);
  const onFailed = (req) => match(req) && (state.failed = true);
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  return {
    get state() {
      return { ...state };
    },
    reset() {
      state.seen = false;
      state.done = false;
      state.failed = false;
    },
    dispose() {
      page.off("request", onRequest);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    },
  };
}

/**
 * 回答区状态（真机验证 2026-09，语义化类名，无随机后缀）：
 *   - 正文：`.markdown-body`（回答末尾的「推荐问题」在此容器之外，不会混入）
 *   - 回答条数：`[class*="answer-content"]`（注意 user 消息侧无此类）
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

  const answers = [...document.querySelectorAll('[class*="answer-content"]')].filter(vis);
  const mds = [...document.querySelectorAll(".markdown-body")].filter(vis);
  const lastMd = mds[mds.length - 1] ?? null;
  const text = lastMd ? clean(collectText(lastMd)) : "";

  const stopVisible = [...document.querySelectorAll("div,button,span")].some(
    (el) => el.children.length === 0 && /^(停止|Stop|终止)$/.test((el.textContent || "").trim()) && el.getClientRects().length > 0
  );

  const buttons = [...document.querySelectorAll("button, [role=button], img, div")]
    .map((b) => ({
      label: `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`.trim(),
      visible: vis(b),
    }))
    .filter((b) => b.visible && /下载|复制|download|copy/i.test(b.label));

  return {
    text,
    textLen: text.length,
    answerCount: answers.length,
    markdownCount: mds.length,
    stopVisible,
    isStreaming: stopVisible,
    buttons,
    downloadLabel: buttons.find((b) => /下载|download/i.test(b.label))?.label ?? null,
    url: location.href,
  };
};

export async function snapshotMarkers(page) {
  try {
    return await page.evaluate(EXTRACT_FN);
  } catch {
    return { text: "", textLen: 0, answerCount: 0, markdownCount: 0, stopVisible: false, buttons: [] };
  }
}

/**
 * 等本次回答完成：网络结束 + 文本连续 N 次采样不变 + 只认新增回答。
 * minAnswers / minMarkdowns：发送前的基线（页面会恢复最近会话，必须只认新增）。
 *
 * 智谱风控（整页被「访问验证」替换）的三种状态都要有确定行为：
 *   1. 等用户完成验证期间 —— **回答超时时钟暂停**（用户拖多久都不烧 `--timeout` 预算）；
 *   2. 验证通过后 —— 只给 challengeGraceMs 宽限；仍无新增正文就立刻返回
 *      `reason:STREAM_STALLED + challenge:true + cleared:true`，由上层**马上重发**；
 *   3. 一直没完成 —— 超过 challengeWaitMs 返回 `HUMAN_VERIFICATION_REQUIRED`（不重发）。
 * 页面/浏览器被用户关闭 → `reason:"BROWSER_CLOSED"`（旧实现会抛 INTERNAL_ERROR 崩掉）。
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
    // 智谱风控：整页被「访问验证」替换（输入框与回答都消失）→ 停止轮询，等用户完成
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

    if (challengeStartedAt && challengeClearedAt === null) {
      challengeClearedAt = Date.now();
      pausedMs += challengeClearedAt - challengeStartedAt; // 等待用户完成验证的时间不计入回答超时
      onChallenge?.({ phase: "cleared" });
    }

    lastState = await evalOrNull(EXTRACT_FN);
    if (lastState?.__closed) return { ok: false, reason: "BROWSER_CLOSED", elapsedMs: activeElapsed() };
    const cs = completion?.state ?? { seen: false, done: false, failed: false };
    const netIdle = !cs.seen || cs.done || cs.failed;

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
        net: `${cs.seen ? "seen" : "-"}/${cs.done ? "done" : cs.failed ? "failed" : "-"}`,
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

/** 开新对话：点侧栏「新对话」（真机验证：点击后 URL 变为无 cid 的新页）。 */
export async function startNewChat(page) {
  const clicked = await page.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0;
    const btn = [...document.querySelectorAll("button,a,[role=button],div,span")].find(
      (e) => vis(e) && /^新对话$/.test((e.innerText || "").trim())
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (clicked) await page.waitForTimeout(2500);
  return { clicked };
}

/**
 * 等滑块/人机验证消失（用户在浏览器里完成）。
 * onWait：首次检测到验证时回调（CLI 用来提示「触发风控、需人工验证」）；
 * onTick：每 ~20 秒回调一次（CLI 播报剩余等待时间，不让用户面对一个「卡住」的窗口）。
 * 用户中途关掉浏览器 → `{ cleared:false, aborted:true }`（CLI 据此报 BROWSER_CLOSED，
 * 而不是像旧实现那样抛 `Target page ... closed` 的 INTERNAL_ERROR 崩掉，实测踩过）。
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

/* ---------------------------------- 产物下载 --------------------------------- */

export const DOWNLOAD_BUTTONS_FN = () => {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  return [...document.querySelectorAll("button, [role=button], img, div")]
    .map((b, idx) => {
      const r = b.getBoundingClientRect();
      const inView = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
      return {
        idx,
        label: `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`.trim(),
        visible: r.width > 0 && r.height > 0,
        inView,
      };
    })
    .filter((b) => b.visible && /下载|保存|download|save/i.test(b.label))
    .sort((a, b) => Number(b.inView) - Number(a.inView) || a.idx - b.idx);
};

export const LOCATE_BUTTON_FN = async ({ idx, label }) => {
  const b = [...document.querySelectorAll("button, [role=button], img, div")][idx];
  if (!b) return null;
  const now = `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`.trim();
  if (now !== label) return null;
  b.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await new Promise((r) => setTimeout(r, 250));
  const r = b.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  return {
    label,
    x,
    y,
    hitSelf: !!hit && (hit === b || b.contains(hit) || hit.closest("button, [role=button], img") === b),
  };
};

export async function downloadArtifact(page, ctx, outDir, { timeoutMs = 60000 } = {}) {
  const candidates = await page.evaluate(DOWNLOAD_BUTTONS_FN);
  if (!candidates.length) return { ok: false, reason: "NOT_FOUND", message: "页面上没有下载/保存按钮" };

  const saved = [];
  const onDownload = async (d) => {
    try {
      const file = path.join(outDir, d.suggestedFilename());
      await d.saveAs(file);
      saved.push({ file, suggested: d.suggestedFilename(), bytes: fs.statSync(file).size });
    } catch (error) {
      saved.push({ ok: false, error: String(error).slice(0, 150) });
    }
  };
  page.on("download", onDownload);

  const waitSaved = async (ms) => {
    const started = Date.now();
    while (!saved.length && Date.now() - started < ms) await page.waitForTimeout(800);
    return saved.length > 0;
  };

  let used = null;
  const diag = [];
  try {
    for (const cand of candidates.slice(0, 3)) {
      const loc = await page.evaluate(LOCATE_BUTTON_FN, cand).catch(() => null);
      if (!loc) continue;
      diag.push(`${loc.label}@${loc.x},${loc.y}${loc.hitSelf ? "" : "(被遮挡)"}`);
      if (!loc.hitSelf) continue;
      await page.mouse.click(loc.x, loc.y);
      if (await waitSaved(Math.min(timeoutMs, 20000))) {
        used = loc.label;
        break;
      }
    }
  } finally {
    page.off("download", onDownload);
  }
  return saved.length
    ? { ok: true, label: used, files: saved }
    : { ok: false, reason: "SEND_FAILED", message: `点击下载后没有触发下载事件（候选：${diag.join(" | ") || "无"}）` };
}
