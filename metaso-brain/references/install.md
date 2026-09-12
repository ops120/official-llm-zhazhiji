# 安装、配置与维护

## 依赖

- Node.js ≥ 20
- 系统已安装 Chrome / Edge / Brave / Chromium 任一（自动探测，无需下载 Chromium）
- 能访问 `metaso.cn` 的**浏览器**
- 一个秘塔账号（**可选**：metaso 游客可直接搜索；登录解锁更多额度与历史云同步）

**无需 API key。**

> **合规与账号风险**：本项目通过浏览器自动化驱动秘塔官方网页版，
> 可能不符合秘塔服务条款，存在账号被风控或限制的风险。
> 请自行评估并遵守平台条款，**风险自负**；仅供低频个人使用。

## 安装

本仓库根目录就是 skill 目录：

```bash
git clone https://github.com/ops120/metaso-brain ~/.claude/skills/metaso-brain   # Claude Code
git clone https://github.com/ops120/metaso-brain ~/.codex/skills/metaso-brain    # Codex
git clone https://github.com/ops120/metaso-brain ~/.agents/skills/metaso-brain   # 通用 / ZCode
```

> 仓库内一律 LF（`.gitattributes` 强制），Windows / macOS / Linux 检出均可直接运行。

## 定位 skill 根

命令里的 `<skill-root>` = `SKILL.md` 所在目录。按顺序尝试：

1. 宿主的 skill 加载路径（通常已在上下文里给出）；
2. 常见位置：`~/.claude/skills/metaso-brain`、`~/.codex/skills/metaso-brain`、`~/.agents/skills/metaso-brain`；
3. 仍找不到 → 问用户。

## 首次配置

```bash
node "<skill-root>/scripts/msb/cli.mjs" setup
```

依次：检查 Node 与浏览器 → 把 `playwright-core` 装到状态目录 → 打开浏览器等待登录（**可跳过**）→ 导出会话。

登录说明：

- **游客即可用**：setup 过程中直接关闭浏览器窗口即跳过登录（CLI 会报告 `loginState: "anonymous"`），
  之后走游客模式（简洁 / 深入档可用，深度研究会弹登录墙、历史不进云空间）。
- 登录支持**手机号验证 / 微信扫码 / 账号密码**，需用户本人操作（真机验证 2026-09-12）。
- **登录 cookie（真机验证 2026-09-12）**：登录后新增 `sid` + `uid`（`.metaso.cn` 域，
  **持久 60 天**）。游客也有 `tid`（400 天）/ `_c_WBKFRo`（365 天）等追踪 cookie，
  不能用作登录判据。
- **登录判定以页内 `GET /api/my-info` 为主**（游客返回 `{errCode:401, errMsg:"需要登录"}`）。
  ⚠️ 实测：打开登录弹窗时左上角「登录/注册」按钮就消失了——**UI 判据会提前误报登录成功**，
  CLI 已按 my-info 探测实现（按钮消失 213 秒后 my-info 才翻转，实测日志在案）。

## 登录持久化原理

metaso 的登录 cookie 名单未知（v1 未拿登录态样本），机制层按「cookie 不可依赖」设计：
每次启动从 `storage-state.json` 注入上次导出的**全部** cookie（含会话 cookie），
profile 持久化 + storage-state 导出双保险保住登录态与游客身份。
登录态的**判定**始终走 `/api/my-info`，不依赖具体 cookie 名——站点将来换 cookie 方案也不受影响。

## 状态目录

| 系统 | 路径 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\metaso-brain\` |
| macOS | `~/Library/Application Support/metaso-brain/` |
| Linux | `$XDG_STATE_HOME/metaso-brain/`（未设置时 `~/.local/state/metaso-brain/`） |

覆盖变量：`MSB_STATE_DIR`；浏览器路径覆盖：`MSB_BROWSER_PATH`；日志级别：`MSB_LOG_LEVEL`（debug/info/warn/error）。
`profile/` 与 `storage-state.json` 含登录态与游客身份，**永不**导出到项目目录、**永不**进日志、**永不**进 prompt。

## 更新与卸载

- 更新：`git -C <skill-root> pull`（依赖与登录态在状态目录，不受影响）。
- 卸载：删 skill 目录 + `rm -rf <状态目录>`（后者会清掉登录态与游客身份）。
- 单独清登录态：`msb logout`（清 profile 与 storage-state；游客身份一并清除，下次首访重建）。
