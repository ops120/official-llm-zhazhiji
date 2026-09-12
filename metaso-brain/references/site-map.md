# metaso.cn 站点地图（真机实录）

> 全部内容来自真机探查（2026-09-12，Chrome / Windows，游客态）。
> metaso 前端是 **Next.js + MUI + CSS-Modules**：类名大量带哈希后缀（`__kjgyz`），
> **不要**依赖完整类名做锚点；用 `data-testid` 或 `[class*=稳定前缀]`。

## 页面拓扑

| 页面 | URL | 说明 |
| --- | --- | --- |
| 首页 | `https://metaso.cn/` | composer + 强度档位 + 范围下拉；游客直接可用 |
| 会话页 | `https://metaso.cn/chat/<雪花id>` | 一次搜索 = 一个会话；回答流式渲染；底部有追问输入框 |
| （v2 路由） | `https://metaso.cn/search/<id>` | Next.js 路由层存在 search-v2 路径，对外 URL 是 `/chat/<id>` |
| （登录墙流程） | `https://metaso.cn/chat/temp-<uuid>` | 游客点深度研究：先开 temp 会话、随即弹登录墙（实测 2026-09-12） |

## 首页

- **composer**：真 `textarea`（React 受控，MUI）
  - class：`search-consult-textarea search-consult-textarea_search-consult-textarea__kjgyz`
  - `data-testid="MetaTextArea.textarea.请输入Enter键发送ShiftEnte"`
  - placeholder 自述发送方式：**「Enter键发送，Shift+Enter键换行，"/"打开自定义技能」**
  - 页面没有独立发送按钮 → 发送 = 聚焦后按 Enter
- **强度档位**（分段控件，容器 `[class*="meta-model-tab_tab-container"]`）：
  - 三个按钮：`data-testid="ModelTab.MetaButton.0/1/2"` = **简洁 / 深入 / 深度研究**
  - 深度研究按钮内嵌渐变文字 `data-testid="useModelItems.div.深度研究"` + 下拉箭头
    （`research-option-button`，展开先想后搜 / 先搜后扩子选项）
  - 选中态：按钮 class 含 **`meta-model-tab_active`**（哈希后缀，用 `[class*=]` 匹配）
  - **站点默认档 = 深入**（index 1）
- **范围下拉**：「全网 / 互动网页」（`search-kits_home-search-box__k3GoF` 容器内）；
  结果页另有 全网 / 文库 / 学术 / 图片 / 视频 / 播客 标签
- **左侧菜单**：登录/注册、主页、专题、今天学点啥、书架、设为默认、历史记录、手机端、更多
  - 「登录/注册」是叶子元素、文案带斜杠——登录态界面判据靠它（整体匹配，别用「登录」子串）
- **其他入口**：学点啥 / 视频生成 / 幻灯片 / 上传文件 / API

⚠️ **水合时序坑**：composer 先挂载、左侧菜单与档位控件后挂载。
`gotoSite` 的 ready 条件（hasEditor）满足时读档位会拿到 null——必须带重试
（`site.readIntensityStable`），doctor / ask / list-models 都踩过。

## 会话页（/chat/<id>）

- **回答正文**：`.markdown-body`（每轮回答一个，无随机后缀——与 chatglm 同款类名）
- **引用角标**：span，class 含 `reference-dot`（另有 `reference-num`）；一 Answer 内多个角标可指向同一来源
- **来源面板**：右侧，容器 `[class*="search-origin-box"]`，来源标题卡 `[class*="contentContainer"]`
  （⚠️ `contentContainer` 是通用词，必须限定在 origin-box 祖先内取）
- **思考标记**：`data-testid="ReasoningView.MotionMetaBtn.思考了"`（「思考了5.44s」）
- **追问输入框**：结果页唯一的 textarea，placeholder「请输入您的问题」（Tailwind 风格类名，无 testid）
  - ⚠️ 结果页**没有**强度档位控件——追问时不能切档
- **底部衍生视图**：生成幻灯片 / 展示海报 / 来源 / 脑图 / 大纲（页内交互，v1 不自动化）
- **页脚**：「内容由AI生成，请仔细甄别」
- 会话页 title = 首问文本

## 网络端点

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/api/search-result` | POST | 检索来源（完成判定信号之一）；body 形如 `{"resultId":"<uuid>"}` |
| `/api/search/chat` | POST | 流式回答（完成判定信号之一） |
| `/api/conversation/<convId>/branched-messages` | GET | **会话元数据（确定性数据源）**，见下 |
| `/api/my-info` | GET | 登录态探测：游客 `{errCode:401, errMsg:"需要登录"}` |
| `/api/html-report?dataIds=<id>` | GET | 报告数据 |
| `files.metaso.cn` | GET | 静态资源 / 官网配置 |

完成判定用 `watchCompletion` 计数前两个 POST：**全部结束才算 netIdle**
（第一个请求先结束不能提前放行），兜底是文本稳定采样。

### branched-messages（`site.fetchThreadMeta`，真机验证 2026-09-12）

`GET /api/conversation/<convId>/branched-messages`（convId = /chat/<id> 的 id）返回：

```
data.activePathMessages[]           # 当前活跃路径的消息
  .role                             # USER / ASSISTANT
  .mode / .model                    # 服务端实际档位与内部模型（实测见下表）
  .totalCiteNum                     # 正文引用角标总数（简洁/深入档；深度研究为 null）
  .citation[]                       # 完整引用：link / title / site / date / snippet / 权重分等
  .chatId                           # uuid，即 POST /api/search-result 的 resultId
data.messageTree                    # 分支树（追问分支）
```

实测档位↔服务端标识对照：

| 页面档位 | `mode` | `model` |
| --- | --- | --- |
| 简洁 | `concise` | `fast_thinking` |
| 深入 | （默认档，未单独取值） | — |
| 深度研究 | `think-research` | `fast` |

CLI 取「最后一条 ASSISTANT」的 citation/mode/model/totalCiteNum——**只读 GET 不耗额度**，
比抓 DOM 可靠（DOM 里的来源卡不带 link，链接要靠这个接口）。
⚠️ citation[] 是「每个引用角标一条」（实测深度研究 159 条、同一来源重复出现），
CLI 按 URL 去重后返回 sources。
⚠️ **任务未完成时 citation 为 null**（实测：超时截断后立即复访拿到空；
完整完成的深度研究引用齐全 159 条）——别把「没等完」误读成「没有来源」。

### 额度字段（my-info，真机 2026-09-12）

`GET /api/my-info` 登录态 `data.user` 里的额度相关字段：
`creditRest`（剩余）/ `creditTotal`（总额）/ `todayFreePoint`（今日免费点数）/ `searchCount`（今日搜索次数）/ `balance`（付费余额）。

真机对账：一天内多次深度研究后 **`creditRest` 100 → 31**（扣减真实发生，
与网络调研口径「深度研究约 20–30 积分/次」吻合）；`searchCount` / `todayFreePoint` / `creditTotal`
**不随用而变**，不能当剩余额度读；扣减可能有**延迟**（首跑完成后立即查仍显示 100）。
⚠️ 该响应含手机号 / 用户名等个人信息，**不要**把响应体写入文档或日志。

### 瞬时 toast（诊断坑）

限流 / 频率提示是**转瞬即逝的 toast**：失败后保存的页面快照里通常已消失
（实测「稍后再试」类文案在 ask-timeout HTML 中零命中）。
因此 `STATE_FN` 把命中的文案片段随状态返回（`rateLimitedText` / `loginWallText`），
CLI 失败载荷里会带上，事后不必再猜。

## Cookie（游客态，真机 2026-09-12）

`JSESSIONID`（metaso.cn / files.metaso.cn）、`aliyungf_tc`、`tid`（.metaso.cn）、`_c_WBKFRo`、`_nb_ioWEgULi`
——均为会话级，**没有**可区分登录的名单（登录态样本待积累；判定走 `/api/my-info`）。
