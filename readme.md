# official-llm-zhazhiji

官方 LLM 榨汁机。🍊

榨的对象是**官方 Web 端 LLM**——不是 API，是浏览器里那个网页版。
方式是通过 **harness** 驱动它：接管会话、自动调用、持续压榨，
把额度、上下文和能力榨到最后一滴，**告别 token 匮乏的烦恼**。

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

## 共享设计（同族机制层）

三个仓库的 `scripts/<cli>/src/` 布局完全相同，把「能复用的」和「站点专属的」切得很干净：

| 文件 | 角色 |
| --- | --- |
| `sanitize.mjs` | 发送前的确定性净化闸门（三仓一致） |
| `logger.mjs` | 脱敏日志（三仓一致） |
| `paths.mjs` / `session.mjs` | 状态目录布局、线程与检查点（三仓仅有极小差异） |
| `browser.mjs` | 站点专属：浏览器探测、启动参数、**登录持久化** |
| `site.mjs` | 站点专属：选择器、输入注入、完成判定、内容抽取 |

因此三者共享同一套行为约定：

- **确定性脱敏闸门**（发送前，代码强制）：私钥整段拒绝、密钥形状与家目录路径脱敏；
  单次正文 ≤ 50 KB（`--allow-large` 放宽到 200 KB），超限报 `PAYLOAD_TOO_LARGE`。
- **人工登录一次，长期复用**：登录/人机验证只在网站重弹时才打扰你（`LOGIN_REQUIRED` /
  `HUMAN_VERIFICATION_REQUIRED`，一次只给一个动作）；agent 不接触凭证。
- **协作协议**（`[DSB]` / `[DBB]` / `[GMB]`）：让大脑做 PLAN → 你执行 → 它 REVIEW 的循环，
  **执行权始终在本地 agent 手里**；迭代上限默认 12 轮，到顶暂停问用户。
- **可枚举的失败码**：`ok:false` 时 `reason` 必属枚举集，每个码有对应动作；
  硬规则——绝不把失败伪装成结果，绝不静默降级后不告知，同类失败最多重试 2 次。
- **状态目录隔离**：回答正文默认不落盘（只记元数据）；cookie / storageState **永不**导出到
  项目目录、**永不**进日志、**永不**进 prompt；目录权限 `0700`、文件 `0600`。
- **`doctor` 体检**：每个任务前跑一次；`doctor --deep` 做真机探测，站点改版时用于定位选择器漂移。

## 安装

前置要求（三个 brain 相同）：

- **Node.js ≥ 20**
- 系统已装 **Chrome / Edge / Brave / Chromium** 任一（自动探测，**不下载 Chromium**）
- 能访问对应站点的浏览器，以及一个对应账号（**无需 API key**）

把对应的仓库 clone 到宿主的 skills 目录即可，无需改任何路径
（以 deepseek-brain 为例，`doubao-brain` / `gemini-brain` 同理，换个名字）：

```bash
git clone https://github.com/ops120/deepseek-brain ~/.claude/skills/deepseek-brain   # Claude Code
git clone https://github.com/ops120/deepseek-brain ~/.codex/skills/deepseek-brain    # Codex
git clone https://github.com/ops120/deepseek-brain ~/.agents/skills/deepseek-brain   # 通用 / ZCode
```

想一次拿到全部三个（作为 submodule 的项目结构，用于浏览或二次开发）：

```bash
git clone --recursive https://github.com/ops120/official-llm-zhazhiji.git
```

装好后对 agent 说：**「用 deepseek-brain 完成首次配置」**（换 `doubao-brain` / `gemini-brain` 同理）。
首次配置会检查环境、把 `playwright-core` 装到状态目录、打开有头浏览器**请你本人登录**，然后冒烟验证。

> **关于命令写法**：下文 `dsb` / `dbb` / `gmb` 都是简写，等价于
> `node "<skill-root>/scripts/<cli>/cli.mjs" <命令>`，其中 `<skill-root>` 就是 clone 下来的仓库目录。
> 想用短命令就自己做别名，例如：
> ```bash
> alias dsb='node "$HOME/.agents/skills/deepseek-brain/scripts/dsb/cli.mjs"'
> ```

## 快速上手

三个 CLI 的命令面同构（`doctor` / `ask` / `thread` / `session` / `logs` …），
所有命令都支持 `--json`（机器可读）、`--debug`（存页面 HTML 排障）、`--keep-open`（保留浏览器窗口）。

### 🐋 deepseek-brain —— 推理与联网搜索

```bash
dsb doctor --json                                             # 体检，建议每次任务前跑
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
  --capability "视频生成" --timeout 900000 --json          # 异步，给足超时
dbb ask --prompt "分析下这段代码" --model "2.1 Turbo" --json
```

> ⚠️ **生成类任务必须显式指定 `--capability`**（`图像生成` / `视频生成` / `音乐生成` /
> `AI 播客` / `录音转写` / `帮我写作`）。不切能力时豆包只会回一段文字描述，页面上不渲染产物。
> 可用能力以页面实际显示为准（`dbb list-models` 可查）。

### ♊ gemini-brain —— 高清生图与代码 Canvas

```bash
gmb doctor --json
gmb ask --prompt "画一只橘猫坐在窗台上，水彩画风格" --thread new --json   # files[] 给原图路径
gmb ask --prompt "用纯 SVG 写一个循环动画：鹈鹕骑自行车" --thread new --json  # 代码走 Canvas
gmb ask --prompt "分析下这段代码" --model Pro --json
```

> **登录提示**：Google 对自动化浏览器有风控，**建议用小号**；登录时会遇到 reCAPTCHA，需你本人点选。

## 怎么选

| 你想要什么 | 用哪个 |
| --- | --- |
| 深度推理、算法/数学、疑难调试思路 | deepseek（`--think on`） |
| 实时信息查证（版本、价格、新闻、文档更新） | deepseek（`--search on`） |
| 生成图片 / 视频 / 音乐 / 播客，录音转写 | doubao |
| 高分辨率生图（2816×1536 原图） | gemini |
| 可运行的代码 / 页面 / 动画（Canvas + 下载源文件） | gemini |
| 中文长文写作辅助 | doubao（「帮我写作」） |
| 第三方独立意见、与本地模型交叉验证 | 任意一个都行，换个「大脑」问 |

## 项目结构

```
official-llm-zhazhiji/
├── deepseek-brain/     # submodule → github.com/ops120/deepseek-brain（DeepSeek 网页版 → dsb CLI）
├── doubao-brain/       # submodule → github.com/ops120/doubao-brain（豆包网页版  → dbb CLI）
├── gemini-brain/       # submodule → github.com/ops120/gemini-brain（Gemini 网页版 → gmb CLI）
└── readme.md           # 本文件
```

三个子目录是 **git submodule**：各自指向独立仓库、各自保留完整 git 历史；
主仓库只记录它们的提交指针。改子模块内容要在对应目录里提交并推送，
主仓库再 commit 一次新的指针。

每个子仓库的结构一致：`SKILL.md`（给 agent 的说明书）、`README.md`（给人看的完整文档）、
`references/`（安装 / 失败处理 / 站点地图 / 协作协议）、`scripts/<cli>/`（CLI、`src/`、`tests/`）。

## 边界与注意

- **低频辅助工具**：每次问答会真实打开一个浏览器窗口（几秒后自动关闭），
  请按「偶尔咨询」的频率使用，**不做批量、不做并发**（同一时间只跑一个会话）。
- **不做 web2api**：只驱动官方网页，不构造私有协议请求、不做逆向代理。
- **会消耗网页版每日额度**：豆包视频生成会明确提示「本次生成将消耗每日免费额度」。
- **prompt 会发往对应站点**：发送前有确定性闸门兜底，但用户未同意时不要发送私密/内部数据。
- **产物归平台**：豆包生成的图片/视频带「豆包AI生成」水印（平台行为，无法去除）；
  生成类产物的下载 URL 是签名链接，会过期，必须当次提取当次下载。
- **失败就是失败**：`ok:false` 会带可枚举 `reason` 如实上报，不会被伪装成结果。

## 加第四个大脑

复制一个现有仓库，机制层文件（`sanitize.mjs` / `logger.mjs` / `paths.mjs` / `session.mjs`）
可原样复用，只需按新站点重写两个文件：

- `browser.mjs` —— 浏览器探测与**登录持久化**（不同站点的 cookie 策略可能不同，
  参考 gemini-brain 的「三重保险」与 doubao-brain 的持久型 cookie 结论）
- `site.mjs` —— 选择器、输入注入、完成判定、内容/产物抽取（站点专属，**不能直接跑**）

## 许可证

本项目基于 MIT License 开源。

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区进行开源推广，感谢社区佬友的交流、反馈与建议。
