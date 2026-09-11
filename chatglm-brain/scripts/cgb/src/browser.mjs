import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dirs, ensureDir, readJson, writeJson } from "./paths.mjs";
import { log } from "./logger.mjs";

/**
 * 浏览器自适应探测（五层，从最明确到最兜底）：
 *   1. 环境变量覆盖 CGB_BROWSER_PATH
 *   2. 常见安装路径（多厂商 / 多渠道 / 多盘符）
 *   3. PATH 里的可执行名
 *   4. Windows 注册表 App Paths（不写死盘符）
 *   5. 交给 Playwright 的 channel 机制
 */
export function findBrowser() {
  const envPath = process.env.CGB_BROWSER_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return { executablePath: envPath, via: "env" };
    log("warn", `CGB_BROWSER_PATH 指向的文件不存在，已忽略：${envPath}`);
  }

  const rel = [
    "Google/Chrome/Application/chrome.exe",
    "Google/Chrome Beta/Application/chrome.exe",
    "Google/Chrome Dev/Application/chrome.exe",
    "Google/Chrome SxS/Application/chrome.exe",
    "Microsoft/Edge/Application/msedge.exe",
    "BraveSoftware/Brave-Browser/Application/brave.exe",
    "Vivaldi/Application/vivaldi.exe",
    "Chromium/Application/chrome.exe",
  ];
  const roots = [
    "C:/Program Files",
    "C:/Program Files (x86)",
    process.env.LOCALAPPDATA?.replace(/\\/g, "/"),
    process.env.PROGRAMFILES?.replace(/\\/g, "/"),
    process.env["PROGRAMFILES(X86)"]?.replace(/\\/g, "/"),
  ].filter(Boolean);

  const candidates = {
    win32: roots.flatMap((r) => rel.map((x) => `${r}/${x}`)),
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/snap/bin/chromium",
      "/var/lib/flatpak/exports/bin/com.google.Chrome",
    ],
  }[process.platform] ?? [];

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return { executablePath: file, via: "path-scan" };
    } catch {
      /* 权限问题忽略 */
    }
  }

  const names =
    process.platform === "win32"
      ? ["chrome.exe", "msedge.exe", "brave.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (fs.existsSync(file)) return { executablePath: file, via: "PATH" };
      } catch {
        /* ignore */
      }
    }
  }

  if (process.platform === "win32") {
    for (const exe of ["chrome.exe", "msedge.exe"]) {
      try {
        const out = execFileSync(
          "reg",
          ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"],
          { encoding: "utf8", windowsHide: true, timeout: 5000 }
        );
        const match = out.match(/REG_SZ\s+(.+\.exe)/i);
        if (match && fs.existsSync(match[1].trim())) return { executablePath: match[1].trim(), via: "registry" };
      } catch {
        /* 注册表项不存在 */
      }
    }
  }

  return { channel: "chrome", via: "playwright-channel" };
}

export function depsEntry() {
  return path.join(dirs().deps, "node_modules", "playwright-core", "index.js");
}

export function depsInstalled() {
  return fs.existsSync(depsEntry());
}

export async function loadPlaywright() {
  const entry = depsEntry();
  if (!fs.existsSync(entry)) {
    throw Object.assign(new Error("playwright-core 未安装：先运行 cgb setup"), { code: "DEPENDENCY_MISSING" });
  }
  const mod = await import(pathToFileURL(entry).href);
  return mod.default ?? mod;
}

/**
 * 启动持久化浏览器。
 *
 * chatglm.cn 要点：
 *   - **不用 `--restore-last-session`**：智谱的会话 cookie（chatglm_token 等）是**持久型**，
 *     不依赖 session cookie，因此不需要该 workaround；加了反而会在每次启动时恢复
 *     上次会话的所有标签页，而 CLI 每次问答都会新开一个标签页 → 标签页数量逐次累加
 *     （qwen-brain 实测踩过同样的坑：跑十几次后窗口里堆了二十多个标签页）。
 *     删掉开关 + 启动时收敛标签页（collapseToSinglePage）即可。
 *   - `chromiumSandbox: true`：默认 false 会注入 `--no-sandbox`，
 *     Chrome 会显示「不受支持的命令行标记」警告条，且是自动化特征（招致更严风控）。
 *   - `viewport: null`：固定视口会阻止窗口最大化。
 *   - 优雅关闭（closeBrowser()）：强杀会跳过 cookie 落盘，登录态可能丢。
 *   - ⚠️ 智谱侧风控对「全新 profile」可能弹人机验证；profile 复用 + storage_state
 *     注入能显著降低弹验证的概率（第一次通过后一般会安静一段时间）。
 */
export async function launchBrowser({ headless = false, acceptDownloads = true } = {}) {
  const pw = await loadPlaywright();
  const d = dirs();
  ensureDir(d.profile, 0o700);
  const found = findBrowser();
  if (!found) {
    throw Object.assign(
      new Error("未找到可用的 Chromium 系浏览器（Chrome / Edge / Brave）。可用 CGB_BROWSER_PATH 指定路径。"),
      { code: "DEPENDENCY_MISSING" }
    );
  }

  const launchOpts = {
    headless,
    viewport: headless ? { width: 1280, height: 900 } : null,
    chromiumSandbox: true,
    locale: "zh-CN",
    acceptDownloads,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
    ],
  };
  if (found.executablePath) launchOpts.executablePath = found.executablePath;
  else launchOpts.channel = found.channel;

  log("info", `browser launch: ${found.executablePath ?? `channel=${found.channel}`} (via ${found.via}), headless=${headless}`);

  killOrphanBrowsers();
  const ctx = await pw.chromium.launchPersistentContext(d.profile, launchOpts);
  ctx.setDefaultTimeout(20000);

  // 降低自动化特征
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    const orig = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (orig) {
      window.navigator.permissions.query = (p) =>
        p && p.name === "notifications" ? Promise.resolve({ state: Notification.permission }) : orig(p);
    }
  });

  // 双保险：注入上次导出的 storage_state（含 session cookie）
  injectStorageState(ctx, d.storageState);

  return ctx;
}

/**
 * 从导出的 storage_state 注入 cookie（session cookie 的备份）。
 * 这是登录持久化的第二重保险。
 */
export async function injectStorageState(ctx, stateFile) {
  if (!fs.existsSync(stateFile)) return { injected: 0 };
  try {
    const st = readJson(stateFile);
    if (st?.cookies?.length) {
      await ctx.addCookies(st.cookies);
      log("debug", `已注入 storage_state 的 ${st.cookies.length} 个 cookie`);
      return { injected: st.cookies.length };
    }
  } catch (error) {
    log("warn", `storage_state 注入失败: ${String(error).slice(0, 120)}`);
  }
  return { injected: 0 };
}

/** 导出 storage_state（登录成功后调用；第三重保险的落盘部分）。 */
export async function exportStorageState(ctx, stateFile) {
  try {
    ensureDir(path.dirname(stateFile));
    await ctx.storageState({ path: stateFile });
    const st = readJson(stateFile) ?? {};
    const loginCookies = (st.cookies ?? []).map((c) => c.name).filter((n) => LOGIN_COOKIE_RE.test(n));
    log("info", `storage_state 已导出: ${st.cookies?.length ?? 0} 个 cookie，登录 cookie ${loginCookies.length} 个`);
    return { ok: true, total: st.cookies?.length ?? 0, loginCookies };
  } catch (error) {
    log("warn", `storage_state 导出失败: ${String(error).slice(0, 120)}`);
    return { ok: false, error: String(error).slice(0, 200) };
  }
}

/**
 * 智谱清言的会话 cookie（真机验证 2026-09）。
 * ⚠️ **cookie 无法区分游客与登录**：未登录（游客）首次访问时
 *    `POST /chatglm/user-api/guest/access` 也会下发
 *    `chatglm_token` / `chatglm_token_expires` / `chatglm_refresh_token` / `chatglm_user_id`
 *    （全部持久型）。因此：
 *    - 「有会话」看这里的 cookie（`readLoginCookies().hasSession`）
 *    - 「是否真人登录」必须看**界面**（登录按钮是否可见），由 `site.STATE_FN().signedOut` 提供
 * 智谱清言允许匿名问答（游客模式，额度受限），无会话 cookie 时 CLI 也可用。
 */
export const LOGIN_COOKIE_RE = /^(chatglm_token|chatglm_token_expires|chatglm_refresh_token|chatglm_user_id)$/i;

export async function readLoginCookies(ctx) {
  try {
    const cookies = await ctx.cookies();
    const names = cookies.map((c) => c.name);
    const sessionCookies = names.filter((n) => LOGIN_COOKIE_RE.test(n));
    // 注意：hasSession / loggedIn 只代表「有会话（游客或登录）」，不代表真人登录；
    // 真人登录判定请用 site.STATE_FN().signedOut（登录按钮是否可见）
    return { total: names.length, names, loginCookies: sessionCookies, hasSession: sessionCookies.length > 0, loggedIn: sessionCookies.length > 0 };
  } catch (error) {
    return { total: 0, names: [], loginCookies: [], hasSession: false, loggedIn: false, error: String(error).slice(0, 120) };
  }
}

export async function openPage(ctx) {
  const pages = ctx.pages();
  return pages.length > 0 ? pages[0] : ctx.newPage();
}

/**
 * 收敛到「只留一个标签页」：多余的关掉，返回留下的那个。
 * 旧 profile 里可能残留上次会话恢复出的一堆标签页，每次启动清一遍。
 */
export async function collapseToSinglePage(ctx) {
  const keep = await openPage(ctx);
  const extras = ctx.pages().filter((p) => p !== keep);
  for (const p of extras) await p.close().catch(() => {});
  if (extras.length) log("info", `已关闭 ${extras.length} 个残留标签页，只保留 1 个`);
  return keep;
}

/**
 * 优雅关闭：close() 让 Chrome 走正常退出流程，cookie 才会落盘。
 * 加超时兜底 —— 个别情况下 close() 会挂住（对话框 / 下载中），不能让 CLI 因此卡死。
 */
export async function closeBrowser(ctx, { timeoutMs = 15000 } = {}) {
  let timer;
  try {
    await Promise.race([
      ctx.close(),
      new Promise((r) => {
        timer = setTimeout(r, timeoutMs);
      }),
    ]);
  } catch (error) {
    log("warn", `浏览器关闭异常（已忽略）: ${String(error).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 回收**孤儿浏览器**：上次 CLI 被强杀（Ctrl-C / 任务取消 / 崩溃）时会留下一个
 * 仍占用本 profile 的 Chrome 窗口。Chrome 的 profile 是排他锁（ProcessSingleton），
 * 不清掉的话下一次 launchPersistentContext 会直接失败。
 * 判定依据是命令行里带 `--user-data-dir=<本状态目录>/profile` —— 一定是我们自己
 * 启动的实例（用户日常 Chrome 用的是默认 profile，不受影响）。
 * ⚠️ 必须在持有全局会话锁（acquireLock）之后调用。
 */
export function killOrphanBrowsers() {
  const profileDir = dirs().profile;
  const killed = [];
  try {
    if (process.platform === "win32") {
      const ps = [
        `$p = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe'"`,
        `$p | Where-Object { $_.CommandLine -like '*${profileDir.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`,
      ].join("; ");
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      killed.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    } else {
      const out = execFileSync("ps", ["-Ao", "pid,args"], { encoding: "utf8", timeout: 15000 });
      for (const line of out.split("\n")) {
        if (!line.includes(profileDir) || line.includes("grep")) continue;
        const m = line.trim().match(/^(\d+)/);
        if (!m) continue;
        try {
          process.kill(Number(m[1]), "SIGTERM");
          killed.push(m[1]);
        } catch {
          /* 已退出 */
        }
      }
    }
  } catch {
    /* 探测失败不致命，照常尝试启动 */
  }
  if (killed.length) log("warn", `回收了 ${killed.length} 个占用本 profile 的孤儿浏览器进程`);
  return killed.length;
}
