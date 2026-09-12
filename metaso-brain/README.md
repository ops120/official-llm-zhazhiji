# metaso-brain

把**秘塔AI搜索网页版**（metaso.cn，秘塔科技）当作编码 agent 的**外部大脑**：它出检索与归纳，你的 agent 出执行。
本地确定性 CLI（`msb`）驱动官方网页，不需要 API key，不做逆向代理。

- 状态：**第七个大脑，v1.0.0 正式版**（doctor / ask / 追问 / 档位切换 / 登录 / 深度研究均已真机实测，见「真机实录」）
- 给 agent 的完整说明书是 [SKILL.md](SKILL.md)（选择器、失败分类、协作协议都在那里）

## 目录

- [能力](#能力)
- [安装](#安装)
- [登录（可选）与持久化](#登录可选与持久化)
- [快速上手](#快速上手)
- [自然语言驱动举例](#自然语言驱动举例)
- [命令面](#命令面)
- [返回值契约](#返回值契约)
- [协作协议（MSB）](#协作协议msb)
- [失败处理](#失败处理)
- [状态与隐私](#状态与隐私)
- [原理与已知坑](#原理与已知坑)
- [真机实录](#真机实录)
- [边界](#边界)
- [项目结构](#项目结构)
- [同族项目](#同族项目)

## 能力

| 能力 | 说明 | 怎么用 |
| --- | --- | --- |
| **带来源引用的 AI 搜索** | 回答正文带引用角标，右侧有来源面板；`ask` 返回 `referenceCount` 与 `sources`（**含 URL / 站点 / 日期**） | 直接提问，结果里直接读 |
| **三档搜索强度（可切换）** | 简洁 / 深入（站点默认）/ 深度研究 | `--intensity 简洁`（切换已真机验证，服务端 `mode` 可对照） |
| **游客可直接搜索** | 未登录即可用简洁 / 深入档（**深度研究除外**，会弹登录墙） | `setup` 可跳过登录 |
| **追问延续同一会话** | 结果页输入框继续追问，上下文延续 | 省略 `--thread`（复用工作区线程） |
| **深度研究（需登录）** | 先想后搜 / 先搜后扩的多轮追搜，产出长报告（实测 9 千字级） | 登录后 `--intensity 深度研究 --timeout 1500000` |
| **脑图 / 大纲 / 幻灯片 / 海报** | 回答的衍生视图（页内查看） | v1 未自动化（见「边界」） |

同族里 deepseek 有「智能搜索」、qwen 有「思考研究」，metaso 是**专职搜索引擎**：
引用呈现最完整（正文角标 + 来源列表带外链），适合「查一个技术问题并给出来源」的场景。

## 安装

依赖：

- Node.js ≥ 20
- 系统已装 Chrome / Edge / Brave / Chromium 任一（自动探测，**不下载 Chromium**）
- 网络能访问 metaso.cn（**无需 API key**）
- **有图形界面**：首次配置和每次问答都会真实打开浏览器窗口（问完自动关闭）

把仓库 clone 到宿主的 skills 目录（仓库内部无需改任何路径）：

```bash
mkdir -p ~/.claude/skills ~/.codex/skills ~/.agents/skills   # 已存在则无副作用
git clone https://github.com/ops120/metaso-brain ~/.agents/skills/metaso-brain   # 通用 / ZCode
# Claude Code / Codex 换成 ~/.claude/skills / ~/.codex/skills，同理
```

> 下文 `msb` 是**文档简写**，等价于 `node "<skill-root>/scripts/msb/cli.mjs" <命令>`；
> 可配别名：`alias msb='node "$SKILLS_DIR/metaso-brain/scripts/msb/cli.mjs"'`。
> Windows cmd / PowerShell 无 alias，请直接用完整 `node "..."` 路径。

首次配置：

```bash
node "<skill-root>/scripts/msb/cli.mjs" setup
```

依次：检查环境 → 把 `playwright-core` 装到状态目录 → 打开浏览器等待登录（**可关闭窗口跳过**）→ 导出会话。

## 登录（可选）与持久化

metaso 允许**游客直接搜索**，登录是可选项：

| | 游客 | 登录后 |
| --- | --- | --- |
| 简洁 / 深入档搜索 | ✓ | ✓ |
| 深度研究 | ✗（开跑即弹登录墙） | ✓ |
| 搜索历史 | 仅本机 profile | 云空间同步，可从侧栏找回 |
| 额度 | 积分制（受限） | 更多额度（my-info 实测免费账号 100 点/天口径） |

**登录 cookie（真机验证 2026-09-12）**：登录后新增 **`sid` + `uid`**（`.metaso.cn` 域，**持久 60 天**），
登录一次长期复用。游客也有 `tid`（400 天）/ `_c_WBKFRo`（365 天）等追踪 cookie，**不能**用作登录判据。

⚠️ **登录判定以页内 `GET /api/my-info` 为主判据**（游客返回 `{errCode:401, errMsg:"需要登录"}`），
不看 cookie、也不能只看界面——实测打开登录弹窗时「登录/注册」按钮就消失了，
而 my-info 直到真正登录完成（213 秒后）才翻转：**UI 判据会提前误报登录成功**。

## 快速上手

```bash
# 体检（建议每次任务前跑；--deep 真机探测页面与强度档位）
node "<skill-root>/scripts/msb/cli.mjs" doctor --json

# 普通搜索（游客即可）
node "<skill-root>/scripts/msb/cli.mjs" ask --prompt "用一句话解释什么是死锁" --thread new --json

# 切换强度档（三档任选；深度研究耗时 >10 分钟，给足超时）
node "<skill-root>/scripts/msb/cli.mjs" ask \
  --prompt "对比 REST API 与 GraphQL，给出选型建议" --intensity 深度研究 --thread new --timeout 1500000 --json

# 查看当前档位与可选三档
node "<skill-root>/scripts/msb/cli.mjs" list-models --json

# 追问（复用同一线程，省略 --thread 即可）
node "<skill-root>/scripts/msb/cli.mjs" ask --prompt "展开讲讲第二点" --json
```

对 agent 说人话也一样：**「用秘塔查一下 X，给出来源」**、**「让 metaso 深度研究一下这个问题」**。

## 自然语言驱动举例

| 你想做什么 | 直接对 agent 说 |
| --- | --- |
| 查一个技术问题并给出来源 | 「用秘塔查一下 <问题>，给出来源链接」 |
| 深度调研 | 「让 metaso 深度研究一下 <问题>」 |
| 第三方独立意见 | 「问问秘塔这个方案有什么问题」 |
| 出方案 → 执行 → 复核 | 「让秘塔出方案，你执行，做完让它复核」 |

使用要点：

- **点名最稳**：话里带上「秘塔」或「metaso」，agent 就会走本 skill；英文触发 `use metaso` / `ask metaso`。
- **要出处就用本 skill**：它的回答自带引用列表（含 URL），比宿主搜索的归纳更可核对。
- **追问不用重复背景**：接着聊即可，agent 会复用同一线程。
- **深度研究要有耐心**：单轮实测 >10 分钟，agent 应给足 `--timeout` 并按心跳汇报进度。
- **游客点深度研究不是故障**：会弹登录墙（`LOGIN_REQUIRED`），登录后重试即可。

## 命令面

`--json`（机器可读）与 `--debug`（保存页面 HTML）为全局选项；
`--keep-open`（保留浏览器窗口）只对会打开浏览器的命令有意义。

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `setup` | 首次配置：装依赖 → 等待登录（可关闭浏览器跳过） | `--timeout <ms>` |
| `login` | 补充登录（手机验证 / 微信扫码 / 账号密码） | `--timeout <ms>` |
| `logout` | 清除登录态（清 `profile/` 与 `storage-state.json`；游客身份一并清除） | — |
| `doctor` | 体检 | `--deep`（真机探测页面 / 强度档位 / 登录态）、`--html` |
| `ask` | 搜索 / 追问 | `--prompt` / `--prompt-file`、`--intensity 简洁\|深入\|深度研究`、`--thread new`、`--protocol <状态>`、`--timeout`、`--captcha-wait <ms>`、`--allow-sensitive`、`--allow-large` |
| `list-models` | 列出强度档位（当前 + 三档可选） | — |
| `thread` | 线程管理 | `status` / `use <url>` / `new` |
| `session` | 工作区级线程与检查点 | `get` / `set ...` |
| `logs` | 查看脱敏日志 | `-n <行数>`、`--verbose` |
| `update-check` | 检查更新 | `--force` |

> `--model` 与 `--attach` 会被**显式拒绝**（`INVALID_ARGUMENTS`）：metaso 没有模型下拉（档位用 `--intensity`），
> 「上传文件」入口 v1 未自动化。
>
> **档位只在首页存在**：复用线程追问时不能切档（结果页没有档位控件），
> 需要切档请显式 `--thread new`。

### doctor 检查项

| 检查项 | 含义 |
| --- | --- |
| `node` / `deps` / `browser` / `stateDir` / `network` | 同族通用（Node ≥ 20、依赖、浏览器、状态目录、站点可达） |
| `login` | **仅 `--deep` 时**：cookie 总数 + 登录态（my-info 探测；游客显示「游客模式」，**不算失败**） |
| `deep` | **仅 `--deep` 时**：真机探测编辑器 / 强度档位 / 登录态，并截图 |

## 返回值契约

```json
{
  "ok": true,
  "requestId": "msb_80a1",
  "threadUrl": "https://metaso.cn/chat/2098649190520614913",
  "modes": { "intensity": "简洁", "requested": "简洁", "serverMode": "concise", "serverModel": "fast_thinking" },
  "text": "……回答正文……",
  "referenceCount": 15,
  "sources": [
    { "title": "哈希表是什么？", "url": "https://www.php.cn/faq/140759.html",
      "site": ["www.php.cn", "php.cn", "cn"], "date": "2016年06月07日" }
  ],
  "files": [],
  "mode": "chat",
  "truncated": false,
  "elapsedMs": 8072
}
```

**字段说明**：

- `modes.intensity` —— **实际生效**的强度档位（切换成功 = 切换值；未切换 = 发送前页面当前值）
- `modes.serverMode` / `serverModel` —— 会话 API 返回的**服务端真实**档位与内部模型名
  （简洁→`concise`/`fast_thinking`；深度研究→`think-research`/`fast`）；与 `intensity` 不一致时以它为准
- `referenceCount` —— 正文引用角标总数（服务端 `totalCiteNum`；**深度研究为 null**）
- `sources[]` —— 引用列表（title/url/site/date，来自会话 API citation）；
  **引用数 ≠ 来源数**（多个角标可指向同一来源）；**深度研究的 citation 为空**
- `files[]` —— 恒为空（metaso 无 CLI 可下载产物）
- `truncated` —— `true` 表示可能被截断，需如实告知用户
- `reSent` —— 出现过人机验证、通过后已自动重发（正常现象）

失败（**判别联合**）：`{ "ok": false, "reason": "LOGIN_REQUIRED", "message": "…" }`；
限流 / 登录墙失败会带命中的**页面文案**（`state.rateLimitedText` / `state.loginWallText`），
因为站点用瞬时 toast、事后快照里查不到。

## 协作协议（`[MSB]`）

与同族完全同构：让秘塔当「规划与审查大脑」，**执行权始终在本地 agent 手里**。
信封 `[MSB]` + `STATE:` / `TASK_ID:` / `ITERATION:` 三行，循环 INIT → PLAN → 执行 → REVIEW → DONE，
单任务建议 ≤ 12 轮。详见 [references/protocol.md](references/protocol.md)。

```bash
msb ask --protocol INIT --task msb_f81a --iteration 0 --prompt-file goal.txt --thread new --json
msb ask --protocol EXECUTED --iteration 1 --prompt-file report.txt --json
```

## 失败处理

所有失败可枚举：`{ok:false, reason, message?, retryAfterMs?}`，完整表见
[references/failure-taxonomy.md](references/failure-taxonomy.md)。速查：

| reason | 一句话动作 |
| --- | --- |
| `HUMAN_VERIFICATION_REQUIRED` | 用户本人在浏览器完成验证（CLI 只等不代操作） |
| `LOGIN_REQUIRED` | 登录墙（游客点深度研究必弹）→ `msb login` 后重试 |
| `RATE_LIMITED` | 退避等待；失败里带站点原文案 |
| `STREAM_STALLED` | 深度研究 >10 分钟是正常的，加大 `--timeout` 重跑 |
| `SITE_CHANGED` | 站点改版，更新 metaso-brain |
| `LOCKED` | 另一个 msb 会话占用浏览器，等它结束 |

硬规则：绝不把失败伪装成结果；绝不静默降级；绝不代做人机验证；同类失败最多重试 2 次。

## 状态与隐私

状态目录 `%LOCALAPPDATA%\metaso-brain\`（macOS `~/Library/Application Support/metaso-brain/`、
Linux `$XDG_STATE_HOME/metaso-brain/`；`MSB_STATE_DIR` 可覆盖）：

```
profile/            # 登录态 + 游客身份（sid/uid/tid 等），勿同步分享
storage-state.json  # 会话导出（含登录 cookie），永不导出/入日志/入 prompt
downloads/  threads/  outputs/  logs/  debug/
```

- 回答正文默认**不落盘**（只记元数据）；`--debug` 或失败时的 `debug/` 快照**含未脱敏正文**，排障后删除。
- 覆盖变量：`MSB_STATE_DIR` / `MSB_BROWSER_PATH` / `MSB_LOG_LEVEL` / `MSB_LOG_STDERR`。

## 原理与已知坑

全部来自真机实测（2026-09-12，Chrome/Win），细节见 [references/site-map.md](references/site-map.md)：

1. **水合时序**：首页 composer 先挂载、左侧菜单与档位控件后挂载——ready 即读会拿到 null，
   读档位必须带重试（`readIntensityStable`）。doctor / ask / list-models 都踩过。
2. **发送 = Enter**：composer 自述「Enter键发送，Shift+Enter键换行」，页面没有发送按钮；
   多行 prompt 也安全（换行只是内容，Enter 才发送）。
3. **来源 URL 的正确来源是会话 API，不是 DOM**：`GET /api/conversation/<id>/branched-messages`
   的 ASSISTANT 消息带 `citation[]`（link/title/site/date/snippet 全有）、`totalCiteNum`、`mode`/`model`；
   页面右侧来源卡反而不带链接。只读 GET，不耗额度。
4. **深度研究是另一套形态**：单轮实测 12.4 分钟（正文最后 ~2 分钟才流出，9 分钟超时必截断）；
   `mode:"think-research"`、`model:"fast"`；完整完成后引用齐全（159 个角标），**未完成时 citation 为 null**；
   游客点它会弹登录墙（URL 呈 `chat/temp-<uuid>`，持久性未验证，勿复用）；
   同题连发疑似有频控（距上次 4 分钟触发「稍后再试」toast，冷却约 5 分钟恢复）。
5. **瞬时 toast**：限流/登录墙提示转瞬即逝，事后页面快照里查不到——
   `STATE_FN` 把命中文案随状态返回，失败载荷里可查。
6. **UI 登录判据会提前误报**：登录弹窗一开「登录/注册」按钮就消失，my-info 213 秒后才翻转
   （真机日志在案）——登录判定必须走 API。
7. **锚点策略**：metaso 是 Next.js + MUI + CSS-Modules（类名带哈希后缀），
   一律用 `data-testid`（`ModelTab.MetaButton.N` / `MetaTextArea.textarea.*`）或 `[class*=稳定前缀]`。
8. **额度对账**：my-info 里只有 `creditRest` 是真实扣减字段（一天多次深度研究后 **100 → 31**，
   与调研口径「深度研究约 20–30 点/次」吻合）；`searchCount` / `todayFreePoint` / `creditTotal`
   不随用而变，不能当剩余额度读；扣减可能有延迟（首跑后立即查未见变化）。

## 真机实录

搜索样本（2026-09-12）：游客态简洁/深入档 6 发（间隔 15–60 秒）**零人机验证、零限流**
（对比：chatglm-brain 游客第 3 发即弹验证）；登录态深度研究 3 发 + 简洁档 1 发。
纯导航操作（doctor / list-models / 复访会话页 / 元数据 API）零触发。

| 项目 | 结果 |
| --- | --- |
| doctor / --deep | ✅ 全绿（游客与登录态） |
| ask 新搜索（游客，简洁） | ✅ 8.1s，`referenceCount:3`，来源带 URL |
| ask 追问（复用线程，深入） | ✅ 12.2s，基线去重正确 |
| `--intensity 简洁` | ✅ 生效，服务端对照 `concise`/`fast_thinking` |
| 复用线程 + `--intensity` | ✅ 显式拒绝并提示 `--thread new` |
| `--model` / `--attach` | ✅ 显式拒绝 |
| 深度研究（游客） | ❌ 登录墙（`LOGIN_REQUIRED`，文案「登录后继续搜索」） |
| 登录流程 | ✅ 真人登录成功；`sid`+`uid`（60 天持久）落 profile |
| 深度研究（登录态，第 1 发） | ⚠️ 9 分钟超时截断（STREAM_STALLED）；复访发现报告其实已完成（9142 字）——超时不足，不是故障 |
| 深度研究（登录态，第 2 发） | ⚠️ 发送后 9 秒命中「稍后再试」toast（`RATE_LIMITED`）——同题距第 1 发仅 4 分钟，深度研究疑似有频控 |
| 深度研究（登录态，第 3 发，冷却约 5 分钟） | ✅ **12.4 分钟完成**：20185 字报告、引用角标 159、`serverMode:"think-research"`；心跳显示正文最后 ~2 分钟才流出 |
| ask 新搜索（登录态，简洁） | ✅ 10.1s，来源去重正确 |

额度对账：一天多次深度研究后 `creditRest` **100 → 31**（扣减真实发生，约 20–30 点/次口径吻合；
`searchCount`/`todayFreePoint` 不变，不能当剩余额度读）。

风控恢复策略（与同族一致，已预置在 CLI）：触发风控 → 关闭浏览器重开（登录态保留，最多一次）；
绝不代做人机验证；绝不清登录态/profile 来「修复」风控；本来就是游客则照常继续。

## 边界

- **不做 web2api**：只在本机驱动官方网页，不逆向私有协议、不提供 HTTP API 服务。
- **可能消耗网页版额度**：低频使用；不做批量、不做并发（CLI 用锁文件保证单会话）。
- **prompt 会发往 metaso.cn**：发送前有确定性脱敏闸门（私钥整段拒绝、密钥形状与家目录路径脱敏、
  单次正文 ≤ 50 KB），用户未同意时不发私密数据。
- **附件 / 产物**：`--attach` 显式拒绝；幻灯片 / 海报 / 脑图 / 大纲是页内视图，不下载。
- **深度研究子选项与搜索范围**（先想后搜/先搜后扩；全网/文库/学术/图片/视频/播客）v1 不切换，
  用站点默认。
- **合规与账号风险**：浏览器自动化驱动官方网页可能不符合站点服务条款，存在账号风控风险；
  请自行评估、遵守平台条款，风险自负。

## 项目结构

```
metaso-brain/
├── SKILL.md               # 给 agent 的说明书（frontmatter + 硬规则 + 调用序列）
├── README.md              # 本文件
├── references/            # install / failure-taxonomy / site-map / protocol
└── scripts/msb/
    ├── cli.mjs            # 命令入口（setup/login/doctor/ask/list-models/thread/session/logs）
    ├── package.json
    ├── src/
    │   ├── browser.mjs    # 浏览器探测、启动、登录持久化（sid/uid）
    │   ├── site.mjs       # metaso 专属：选择器、注入、完成判定、会话元数据 API
    │   ├── paths.mjs      # 状态目录布局
    │   ├── logger.mjs     # 脱敏日志
    │   ├── sanitize.mjs   # 发送前确定性闸门（与同族一致）
    │   └── session.mjs    # 工作区线程/检查点/全局会话锁（msb.lock）
    └── tests/sanitize.test.mjs
```

## 同族项目

| 项目 | 官网 | CLI | 一句话特长 |
| --- | --- | --- | --- |
| [deepseek-brain](https://github.com/ops120/deepseek-brain) | chat.deepseek.com | `dsb` | 深度思考 + 智能搜索 |
| [doubao-brain](https://github.com/ops120/doubao-brain) | doubao.com | `dbb` | 生图/生视频/音乐/播客 |
| [gemini-brain](https://github.com/ops120/gemini-brain) | gemini.google.com | `gmb` | 高清生图 + 代码 Canvas |
| [grok-brain](https://github.com/ops120/grok-brain) | grok.com | `grb` | X 平台实时信息 |
| [qwen-brain](https://github.com/ops120/qwen-brain) | qianwen.com | `qwb` | 思考研究 + 匿名可用 |

（第六个 chatglm-brain 尚在开发中，随聚合仓库 [official-llm-zhazhiji](https://github.com/ops120/official-llm-zhazhiji) 一起维护。）

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区进行开源推广，感谢社区佬友的交流、反馈与建议。
