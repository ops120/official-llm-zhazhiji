# official-llm-zhazhiji

官方 LLM 榨汁机。🍊

榨的对象是**官方 Web 端 LLM**——不是 API，是浏览器里那个网页版。
方式是通过 **harness** 驱动它：接管会话、自动调用、持续压榨——
**在站点额度与风控允许的范围内，低频、非批量地辅助使用**。

没有 API key，不做 web2api：只驱动官方网页，用**本地确定性 CLI** 把网页版 LLM
变成编码 agent 的**外部大脑**——它们出推理与内容，你的 agent 出执行。

## 三个大脑

机队现有三台榨汁机，各自独立仓库、独立 skill，互不依赖
（本仓库通过 git submodule 引用它们，三个 brain 的 git 历史完全独立）：

| | [deepseek-brain](https://github.com/ops120/deepseek-brain) | [doubao-brain](https://github.com/ops120/doubao-brain) | [gemini-brain](https://github.com/ops120/gemini-brain) |
| --- | --- | --- | --- |
| **CLI** | `dsb` | `dbb` | `gmb` |
| **官网** | chat.deepseek.com | doubao.com | gemini.google.com |
| **独有能力** | 深度思考 + 智能搜索 | 生图 / **生视频** / 音乐 / 播客 / 录音转写 | 生图（2816×1536 原图）+ 代码 Canvas |
| **模型可选** | ✗（只有「深度思考」「智能搜索」两个开关） | ✓（快速 / 2.1 Turbo） | ✓（Flash-Lite / Flash / Pro） |
| **登录持久化** | 简单 | 简单（字节系 cookie 是持久型） | **复杂**（session cookie，需三重保险） |
| **版本** | 3.0.0 | 3.0.0 | 3.0.0 |

点上面的仓库名进各自的 README，有完整的能力表、命令面、返回值契约与「真机验证过的坑」。

> 表中能力、模型名与分辨率均为编写时实测值；网页版功能会随站点调整，**实际以页面显示为准**。

## 共享设计（同族机制层）

三个仓库的 `scripts/<cli>/src/` **文件构成相同**（文件名一一对应），把「能复用的」和「站点专属的」切得很干净：

| 文件 | 角色 |
| --- | --- |
| `sanitize.mjs` | 发送前的确定性净化闸门（三仓文件一致） |
| `logger.mjs` | 脱敏日志（三仓文件一致） |
| `paths.mjs` / `session.mjs` | 状态目录布局、线程与检查点（**内容按站点差异微调**，如状态目录名） |
| `browser.mjs` | 站点专属：浏览器探测、启动参数、**登录持久化** |
| `site.mjs` | 站点专属：选择器、输入注入、完成判定、内容抽取 |

因此三者共享同一套行为约定：

- **本地 CLI + 确定性闸门**：CLI 自身的接口契约、失败码与发送前脱敏是确定的；
  **模型输出本身当然不确定**（那是模型生成的），不要把它理解成「结果可复现」。
  脱敏闸门（发送前，代码强制）：私钥整段拒绝、密钥形状与家目录路径脱敏；
  单次正文 ≤ 50 KB（按 UTF-8 字节计；`--allow-large` 放宽到 200 KB），超限报 `PAYLOAD_TOO_LARGE`。
  附件（`--attach`）不计入这 50 KB，其格式与大小上限由各站点网页端决定，被拒时报 `UPLOAD_REJECTED`。
  闸门是**基于规则**的确定性检查，能挡住常见凭据形态，但不能替代你对外发内容的人工判断。
- **人工登录一次，之后尽量复用**：登录/人机验证只在网站重弹时才打扰你（`LOGIN_REQUIRED` /
  `HUMAN_VERIFICATION_REQUIRED`，一次只给一个动作）；CLI 不把凭证写入项目目录、日志或 prompt。
  三仓的登录持久化难度不同：DeepSeek 与豆包的 cookie 是持久型，基本一劳永逸；
  **Gemini 依赖 session cookie，站点风控或会话过期时会要求重新登录**。
- **协作协议**（`[DSB]` / `[DBB]` / `[GMB]`）：让大脑做 PLAN → 你执行 → 它 REVIEW 的循环，
  **执行权始终在本地 agent 手里**；建议单个任务不超过 12 轮，到顶暂停问用户。
- **可枚举的失败码**：`ok:false` 时 `reason` 必属枚举集，每个码有对应动作；
  硬规则——绝不把失败伪装成结果，绝不静默降级后不告知，同类失败最多重试 2 次。
- **状态目录隔离**：回答正文默认不落盘（只记元数据；例外是 `--debug` 或失败时的 `debug/` 快照，
  会含未脱敏正文，排障后请删除）；cookie（以及 Gemini / 豆包额外保存的
  `storage-state.json`）**永不**导出到项目目录、**永不**进日志、**永不**进 prompt；
  目录权限 `0700`、文件 `0600`（仅 Unix/macOS 生效，Windows 依赖用户目录 ACL）。
- **`doctor` 体检**：每个任务前跑一次；`doctor --deep` 做真机探测，站点改版时用于定位选择器漂移。

## 安装

前置要求（三个 brain 相同）：

- **Node.js ≥ 20**（建议用当前 Active LTS；含 npm —— 首次配置会把 `playwright-core` 装到状态目录，需要能访问 npm registry）
- 系统已装 **Chrome / Edge / Brave / Chromium** 任一（自动探测，**不下载 Chromium**）
- **网络环境能访问**对应站点，以及一个对应账号（**无需 API key**）。
  注意区分两阶段网络：**安装阶段** Node/npm 要能访问 npm registry（否则装不上 `playwright-core`，
  需自行配 npm 代理或镜像）；**使用阶段** CLI 驱动的是系统浏览器，
  能否访问站点取决于浏览器/系统代理设置（Gemini 常见需代理），Node 直连站点失败不影响使用
- **需要有图形界面**：首次配置要打开有头浏览器请你本人登录，之后**每次问答也会真实打开浏览器窗口**
  （问完自动关闭）；后续若站点重弹验证（人机验证 / 登录失效），同样需要你在图形界面里手动完成。
  纯 SSH / 容器环境无法使用；如必须在服务器上跑，请自行准备 X11 转发或远程桌面

> **先分清两个仓库角色**：本仓库（`official-llm-zhazhiji`）是**聚合主仓库**，
> 用来浏览与二次开发，**不能直接装进 skills 目录**；
> 真正要安装的是下面三个子仓库，按你需要的能力任选其一或多选。

把子仓库 clone 到宿主的 skills 目录即可（仓库内部无需改任何路径；
命令行入口还要按下一节配别名或用完整路径）。
下例以 deepseek-brain 为例，`doubao-brain` / `gemini-brain` 换个名字同理。
若目标目录尚不存在，先建父目录再 clone：

```bash
mkdir -p ~/.claude/skills ~/.codex/skills ~/.agents/skills   # 已存在则无副作用
# Windows cmd（三个父目录一次建好，REM 为注释）:
#   mkdir "%USERPROFILE%\.claude\skills" "%USERPROFILE%\.codex\skills" "%USERPROFILE%\.agents\skills"
# PowerShell:
#   "$env:USERPROFILE\.claude\skills","$env:USERPROFILE\.codex\skills","$env:USERPROFILE\.agents\skills" | ForEach-Object { mkdir $_ -Force }

# 三条命令按你的宿主任选其一，不要全都执行
git clone https://github.com/ops120/deepseek-brain ~/.claude/skills/deepseek-brain   # Claude Code
git clone https://github.com/ops120/deepseek-brain ~/.codex/skills/deepseek-brain    # Codex
git clone https://github.com/ops120/deepseek-brain ~/.agents/skills/deepseek-brain   # 通用 / ZCode
```

> Windows 下 `mkdir` 对已存在目录会提示「已存在」，可忽略；`git clone` 到已存在目录则会失败：若该目录已是 git 仓库，用 `git -C <目录> pull` 更新；
> 否则先删掉旧目录再 clone。

> **Windows 的可复制写法**（cmd 不会展开 `~`，PowerShell 虽通常能展开，仍建议统一用环境变量；
> 下例用 `.agents`，选 Claude Code / Codex 时把 `.agents` 换成 `.claude` / `.codex`）：
> ```bat
> REM cmd
> git clone https://github.com/ops120/deepseek-brain "%USERPROFILE%\.agents\skills\deepseek-brain"
> ```
> ```powershell
> # PowerShell
> git clone https://github.com/ops120/deepseek-brain "$env:USERPROFILE\.agents\skills\deepseek-brain"
> ```

> **clone 完还不能直接运行命令**：下文 `dsb` / `dbb` / `gmb` 是文档简写，不是安装出来的可执行文件。
> 用之前必须先配别名（见本节下方的「关于命令写法」），或把示例里的简写替换成完整 `node "..."` 路径。

只看项目结构、做二次开发才需要主仓库（三个 brain 会作为 submodule 一起拉下来）：

```bash
git clone --recursive https://github.com/ops120/official-llm-zhazhiji.git
```

> 注意：`--recursive` 拉下来的三个 brain **不会被 agent 自动发现**，
> 要让 agent 用上仍需把它们（或其副本）放进宿主的 skills 目录。

装好后对 agent 说：**「用 deepseek-brain 完成首次配置」**（换 `doubao-brain` / `gemini-brain` 同理），
agent 会替你跑 `setup`。也可以自己手动执行首次配置（把路径换成你实际的安装位置）：

```bash
node "$SKILLS_DIR/deepseek-brain/scripts/dsb/cli.mjs" setup   # 换 dbb / gmb 与目录名同理；$SKILLS_DIR 见下节
```

首次配置会检查环境、把 `playwright-core` 装到状态目录、打开有头浏览器**请你本人登录**，然后冒烟验证。
状态目录被删除或迁移后，需要重新跑一次 `setup`（依赖与登录态都在那里）。

> **关于命令写法（重要）**：下文 `dsb` / `dbb` / `gmb` 都是**文档简写**，并非安装好的命令。
> 以 `dsb` 为例，它等价于 `node "<skills 目录>/deepseek-brain/scripts/dsb/cli.mjs" <命令>`。
>
> **推荐：先设一个变量，再配别名**（三种宿主任选对应的一行；想长期生效就写进 `~/.bashrc` / `~/.zshrc`。
> 只装了其中一个 brain 时，只配对应那一行即可，其余别名会指向不存在的路径）：
> ```bash
> # Claude Code 安装：SKILLS_DIR="$HOME/.claude/skills"
> # Codex 安装：      SKILLS_DIR="$HOME/.codex/skills"
> # 通用 / ZCode：    SKILLS_DIR="$HOME/.agents/skills"
> SKILLS_DIR="$HOME/.agents/skills"          # ← 改成你实际用的那个
> export SKILLS_DIR
> alias dsb='node "$SKILLS_DIR/deepseek-brain/scripts/dsb/cli.mjs"'
> alias dbb='node "$SKILLS_DIR/doubao-brain/scripts/dbb/cli.mjs"'
> alias gmb='node "$SKILLS_DIR/gemini-brain/scripts/gmb/cli.mjs"'
> ```
> 不配别名也行：把示例里的 `dsb` 整体替换成 `node "$SKILLS_DIR/deepseek-brain/scripts/dsb/cli.mjs"`。
> Windows 用户在 cmd / PowerShell 里没有 `alias`，请直接使用完整 `node "..."` 路径
> （或自建 `.cmd` / `function` 包装脚本）。

## 快速上手

三个 CLI 的公共命令面同构（`setup` / `login` / `logout` / `doctor` / `ask` / `thread` / `session` / `logs` / `update-check`）；
`list-models` 仅 doubao 与 gemini 有（DeepSeek 网页版没有模型选择器，故无此命令）。
`--json`（机器可读）与 `--debug`（存页面 HTML 排障）为全局选项；
`--keep-open`（保留浏览器窗口）只对会打开浏览器的命令有意义。
各命令的完整参数（`--think` / `--search` / `--attach` / `--capability` / `--model`；
`--protocol` 用于把协作协议信封（PLAN→执行→REVIEW 循环）发给对方）
以各子仓库 README 的命令面章节为准。常用的几条：

```bash
dsb ask --prompt "你的问题" --thread new --json  # 开新线程提问（省略 --thread 则复用当前线程）
dsb thread status --json                        # 看当前线程
dsb session get --json                          # 看工作区检查点（协作协议用）
dsb logs -n 50                                  # 看最近 50 行脱敏日志
```

> 以下示例使用别名简写，**未配别名时请自行展开为完整 `node "..."` 路径**。

> ⚠️ 失败时会**自动**保存页面快照到 `debug/`；`--debug` 则额外保存成功路径的页面 HTML。
> 这些内容
> **可能包含你的 prompt 与模型回答原文（未脱敏）**；
> 它们都保存在状态目录而非项目目录；排障后建议删除，**不要直接上传到公开 issue**。
> 状态目录位置（`<name>` 取 `deepseek` / `doubao` / `gemini`；覆盖变量见表格下方）：
>
> | 系统 | 路径 |
> | --- | --- |
> | Windows | `%LOCALAPPDATA%\<name>-brain\` |
> | macOS | `~/Library/Application Support/<name>-brain/` |
> | Linux | `$XDG_STATE_HOME/<name>-brain/`（未设置时通常为 `~/.local/state/<name>-brain/`） |
>
> 覆盖变量：`DSB_STATE_DIR`（deepseek-brain）/ `DBB_STATE_DIR`（doubao-brain）/ `GMB_STATE_DIR`（gemini-brain）。

### 🐋 deepseek-brain —— 推理与联网搜索

```bash
dsb doctor --json                                             # 体检（--deep 才真机探测/查登录态）
dsb ask --prompt "分析这个报错的原因" --think on --search on --json
dsb ask --prompt "总结这份文档的要点" --attach ./report.pdf --json
```

对 agent 说人话：**「用 deepseek 深度思考分析一下这个报错」**。

### 🫘 doubao-brain —— 多模态产出最全

```bash
dbb doctor --json
dbb ask --prompt "一只布偶猫趴在窗台上晒太阳，油画风格" \
  --capability "图像生成" --thread new --json
dbb ask --prompt "一只熊猫在竹林里啃竹子，阳光斑驳" \
  --capability "视频生成" --thread new --timeout 900000 --json   # 异步，给足超时
dbb ask --prompt "分析下这段代码" --model "2.1 Turbo" --json
```

> ⚠️ **生成类任务必须显式指定 `--capability`**：产物生成类是
> `图像生成` / `视频生成` / `音乐生成` / `AI 播客` / `录音转写`（代码里的判定以此为准）；
> `帮我写作` 属于文本模式，不产出文件。不切能力时豆包只会回一段文字描述，页面上不渲染产物。
> 可用模型与能力栏以页面实际显示为准（`dbb list-models` 可列出当前模型与能力栏）。
> 视频生成的 `--timeout` 单位是**毫秒**，`900000` 即 15 分钟（站点提示的等待时间可达 10 分钟）。

### ♊ gemini-brain —— 高清生图与代码 Canvas

```bash
gmb doctor --json
gmb ask --prompt "画一只橘猫坐在窗台上，水彩画风格" --thread new --json   # files[] 给原图路径
gmb ask --prompt "用纯 SVG 写一个循环动画：鹈鹕骑自行车" --thread new --json  # 代码进 Canvas 面板
gmb ask --prompt "分析下这段代码" --model Pro --json
gmb list-models --json                              # 看可用模型档位
```

> **登录提示**：Google 对自动化浏览器有风控，**建议用小号**；登录时会遇到 reCAPTCHA，需你本人点选。

## 怎么选

| 你想要什么 | 用哪个 |
| --- | --- |
| 深度推理、算法/数学、疑难调试思路 | deepseek（`--think on`） |
| 实时信息查证（版本、价格、新闻、文档更新） | deepseek（`--search on`） |
| 生成图片 / 视频 / 音乐 / 播客，录音转写 | doubao |
| 高分辨率生图（2816×1536 原图） | gemini |
| 可运行的代码 / 页面 / 动画（代码在 Canvas 面板，可下载源文件） | gemini |
| 中文长文写作辅助 | doubao（「帮我写作」） |
| 第三方独立意见、与本地模型交叉验证 | 任意一个都行，换个「大脑」问 |

## 项目结构

```
official-llm-zhazhiji/
├── deepseek-brain/     # submodule → github.com/ops120/deepseek-brain（DeepSeek 网页版 → dsb CLI）
├── doubao-brain/       # submodule → github.com/ops120/doubao-brain（豆包网页版  → dbb CLI）
├── gemini-brain/       # submodule → github.com/ops120/gemini-brain（Gemini 网页版 → gmb CLI）
├── LICENSE             # MIT
└── README.md           # 本文件
```

三个子目录是 **git submodule**：各自指向独立仓库、各自保留完整 git 历史；
主仓库只记录它们的提交指针。改子模块内容要在对应目录里提交并推送，
主仓库再 commit 一次新的指针。

每个子仓库的结构一致：`SKILL.md`（给 agent 的说明书）、`README.md`（给人看的完整文档）、
`references/`（安装 / 失败处理 / 站点地图 / 协作协议）、`scripts/<cli>/`（CLI、`src/`、`tests/`）。

## 边界与注意

> ⚠️ **合规与账号风险（务必先读）**：本项目通过浏览器自动化驱动**官方网页版**。
> 这可能不符合站点的服务条款，存在**账号被限流、弹人机验证、甚至封禁**的风险；
> 各站点风控强度不同（Google 对自动化最敏感，建议用小号）。请自行评估账号风险、
> 遵守对应平台条款，**风险自负**；不要用于批量滥用，也不要尝试绕过站点验证。

- **低频辅助工具**：每次问答会真实打开一个浏览器窗口，用完自动关闭。
  普通问答几秒到几十秒；**生成类任务（生图 / 生视频）会显著更久**，
  豆包视频实测约 3 分钟、站点提示可达 10 分钟，此时需给足 `--timeout`。
  请按「偶尔咨询」的频率使用，**不做批量、不做并发**
  （CLI 用锁文件保证同一时间只跑一个会话，并发调用会被 `LOCKED` 拒绝）。
- **不做 web2api**：只在本机驱动官方网页，不逆向私有协议、不提供 HTTP API 服务、不对外暴露接口。
  它是给本地 agent 用的工具，不是 API 服务（`--json` 只是本机 CLI 的结构化输出）。
- **可能消耗网页版每日额度**：各站点与各能力都可能计费或限次；豆包视频生成会明确提示
  「本次生成将消耗每日免费额度」。
- **prompt 会发往对应站点**：发送前有确定性闸门兜底，但用户未同意时不要发送私密/内部数据。
- **产物归平台**：生成类产物可能带平台水印（豆包图片/视频带「豆包AI生成」，Gemini 生图可能带
  SynthID 等标识）；下载 URL 多为签名链接、会过期，必须当次提取当次下载。
- **失败就是失败**：`ok:false` 会带可枚举 `reason` 如实上报，不会被伪装成结果。

## 加第四个大脑

复制一个现有仓库，`sanitize.mjs` / `logger.mjs` 可原样复用，
`paths.mjs` / `session.mjs` 以现有仓库为模板按需微调，站点相关的两个文件必须重写：

- `browser.mjs` —— 浏览器探测与**登录持久化**（不同站点的 cookie 策略可能不同，
  参考 gemini-brain 的「三重保险」与 doubao-brain 的持久型 cookie 结论）
- `site.mjs` —— 选择器、输入注入、完成判定、内容/产物抽取（站点专属，**不能直接跑**）

## 许可证

本项目基于 MIT License 开源，完整条款见 [LICENSE](LICENSE)；
三个子仓库各自独立遵循 MIT，许可证文件见：
[deepseek-brain](https://github.com/ops120/deepseek-brain/blob/main/LICENSE)、
[doubao-brain](https://github.com/ops120/doubao-brain/blob/main/LICENSE)、
[gemini-brain](https://github.com/ops120/gemini-brain/blob/main/LICENSE)。

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区进行开源推广，感谢社区佬友的交流、反馈与建议。
