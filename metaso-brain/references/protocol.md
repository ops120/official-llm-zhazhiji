# `[MSB]` 协作协议（PLAN → 执行 → REVIEW）

让秘塔做**规划与审查**、本地 agent 做执行——执行权始终在本地手里。
与同族 brain（`[DSB]` / `[DBB]` / `[GMB]` / `[GRB]` / `[QWB]` / `[CGB]`）完全同构。

## 信封格式

发送（agent → 秘塔，`msb ask --protocol <STATE>` 自动封装）：

```
[MSB]
STATE: <INIT | PLAN | EXECUTING | EXECUTED | REVIEW | HANDOFF>
TASK_ID: <id>
ITERATION: <n>

<body>
```

回复判定（秘塔 → agent）：CLI 从回答文本里解析同样的三行
（`STATE:` / `TASK_ID:` / `ITERATION:`），解析结果随 `ask` 返回的 `protocol` 字段给出。

## 循环

1. `--protocol INIT`：下达任务背景，请它出 **PLAN**（它回 `STATE: PLAN`）。
2. 本地执行 PLAN（**你**来改代码 / 跑命令）。
3. `--protocol REVIEW`：把 diff / 结果发回去请求复核（它回 `STATE: REVIEW` 或 `DONE`）。
4. 需要修改 → 回到 2（ITERATION+1）；通过 → `DONE`。
5. 单任务建议 **≤ 12 轮**，到顶暂停问用户。

## 约定

- CLI 侧会话状态机（`INIT → PLAN_RECEIVED → EXECUTING → EXECUTED_LOCAL → EXECUTED_SENT → DONE / BLOCKED`）
  存在工作区检查点（`msb session get/set`），中断后可续。
- 秘塔回复是**参考意见**：PLAN 要核对可行性，REVIEW 意见要核对正确性，执行权不外移。
- 秘塔是搜索归纳型大脑：协议循环里它最擅长的是**调研类 PLAN**（方案选型、资料汇总）
  与**交叉审查**；逐行代码审查不是它的强项。
