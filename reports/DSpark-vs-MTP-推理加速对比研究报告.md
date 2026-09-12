# DSpark vs MTP：大模型推理加速方案对比研究报告

> **检索方式**：metaso.cn 深入档 × 3（分角度：① DSpark 原理与性能 ② MTP 原理与性能 ③ 正面对比与基准）
> **原始会话**：
> ① https://metaso.cn/chat/2098704608855355393 （20s，26 角标/19 源）
> ② https://metaso.cn/chat/2098704994378608641 （22s，34 角标/20 源）
> ③ https://metaso.cn/chat/2098705404139167745 （24s，29 角标/14 源）
> **报告日期**：2026-09-12

## 结论先行（TL;DR）

**「哪个更强」要看比什么——两者不在同一层：**

1. **纯速度上 DSpark 更强，且强得有官方数字**：DSpark 的性能报告全部以 **MTP-1 为对比基线**——单用户生成速度再提升 **57%–85%**；离线基准下平均接受长度比 Eagle3 高 **26.7%–30.9%**、比 DFlash 高 **16.3%–18.4%**。也就是说，DSpark 就是作为「MTP 这一代投机解码的升级替代」设计的。
2. **但 MTP 不是被淘汰的一方**：MTP 是**模型内建技术**（训练目标 + 自起草头），随模型权重自带、推理时「开了就用」，vLLM / SGLang / MindIE / llama.cpp 生态全部支持；DSpark 是**服务侧框架**，要加载专用草稿 checkpoints、目前主要落地在 SGLang（及 vLLM-Ascend RFC），DeepSeek-V4 侧仍是**预览版**。
3. **不是叠加关系**：DSpark 是**替换** MTP-1 路径，不是在 MTP 之上再叠一层。现有材料没有「MTP + DSpark 同时生效」的官方方案。
4. 一句话：**要极限速度、且你的模型/框架有 DSpark 支持 → 用 DSpark；要省事、生态成熟、模型自带 MTP 头 → MTP 直接开，仍然是大多数场景的默认选择。**

---

## 一、两者分别是什么（层级不同，先分清）

| | MTP（Multi-Token Prediction） | DSpark |
| --- | --- | --- |
| **本质** | **模型技术**：在 NTP 之外加辅助预测头，一次预测多个未来 token；既当训练辅助 loss，又当投机解码的「自我起草器」 | **推理加速框架**：DeepSeek 联合北京大学开源（2026-06-27），不改模型权重、只优化解码流程的推测解码系统 |
| **出身** | Meta FAIR 提出（Gloeckle et al., ICML 2024）；DeepSeek-V3 改进为**顺序递进式**预测头（只预测 2 token、共享主干表征） | 论文《Confidence-Scheduled Speculative Decoding with Semi-Autoregressive Generation》；配套 DeepSpec 训练库 |
| **部署形态** | 随模型权重自带（DeepSeek-V3/V4、Qwen3 系列、GLM-4.5、MiMo-V2、MiniMax-M2 等已是标配） | 独立草稿 checkpoints + 推理引擎集成（SGLang 已支持；vLLM-Ascend 有 RFC/issue） |
| **现状** | 生产可用，生态最广 | DeepSeek-V4-Flash / V4-Pro **预览版**引擎已部署；离线支持 Qwen3、Gemma4 等 |

## 二、正面基准对比

### 2.1 DSpark 论文离线基准（2026-06；Qwen3-4B/8B/14B、Gemma4-12B；数学/代码/对话任务）

比的是**平均接受长度**（接受长度越长，单步验证拿到的 token 越多、速度越快）：

| 对比对象 | DSpark 优势 |
| --- | --- |
| vs **Eagle3** | +26.7% ~ +30.9% |
| vs **DFlash** | +16.3% ~ +18.4% |
| （任务维度） | 数学推理、代码生成、日常对话均优于两者 |

### 2.2 生产环境基准（DeepSeek 自有集群、V4 实时流量；**基线 = MTP-1**）

| 指标 | V4-Flash | V4-Pro |
| --- | --- | --- |
| 单用户生成速度（同等吞吐下） | **+60% ~ +85%** | **+57% ~ +78%** |
| 聚合吞吐提升（常规 SLA，如 80 tok/s） | +51% | +52%（35 tok/s SLA） |
| 严格 SLA 下的吞吐优势 | +661%（120 tok/s/user） | +406%（50 tok/s/user） |

> ⚠️ 对 661% / 406% 的正确理解：这不是「快 6 倍」，而是**把原本接近崩溃的严格 SLA 档位拉回可用**（扩宽速度-吞吐 Pareto 边界）；且数字来自 DeepSeek 自有 serving 系统、自有 checkpoints，**未经独立第三方复现**。

### 2.3 MTP 自己的官方成绩（作为参照系）

- DeepSeek-V3 技术报告：第二个 token 预测**接受率 85%–90%**，实现 **1.8× TPS** 解码加速；
- Meta 原始 4-token 并行预测：推理约 **3×** 提速（但接受率随预测深度衰减，这也是 DeepSeek 改为顺序预测 2 token 的原因）；
- 生态实测参考：Qwen3.8-27B 官方 206.1 tok/s（RTX 5090 · NVFP4 + **DSpark** · SGLang）；4× DGX Spark 集群 + SGLang + DSpark 最高 77.3 tok/s 吞吐。

## 三、DSpark 相对原生 MTP 强在哪

1. **半自回归草稿**：草稿头单次前传并行提议整块 token，再由轻量串行 Markov 头注入块内依赖——专门缓解纯并行草稿（DFlash 式）的「末尾接受率衰减」；
2. **置信度调度验证**：置信度头预测每个位置的接受概率，高置信批量放行、低置信提前截断，验证长度按内容动态调整；
3. **硬件感知调度 + 在线校准**：实时读取 GPU 显存/负载动态调整验证策略（材料称可将 decode 阶段 GPU 利用率从不足 1% 提到约 15%——低置信传闻，见置信度说明）；
4. **无损**：属投机解码方法，输出与目标模型完全一致，不牺牲质量。

## 四、代价与适用边界（MTP 仍然能打的地方）

| 维度 | MTP | DSpark |
| --- | --- | --- |
| 部署复杂度 | **零额外部署**：模型自带头，vLLM/SGLang 配置即开 | 需加载专用草稿 checkpoints（backbone + feature projection + Markov head + confidence head），并在 serving 栈做集成 |
| 生态成熟度 | vLLM、SGLang、昇腾 MindIE-LLM、llama.cpp（2026-05 合入）全支持 | SGLang 正式支持；vLLM 主线未见（仅 vLLM-Ascend RFC）；DeepSeek-V4 侧为预览版 |
| 模型覆盖 | DeepSeek-V3/V4、Qwen3 系列、GLM-4.5、MiMo-V2、MiniMax-M2 等标配 | 官方主打 DeepSeek-V4-Flash/Pro；离线扩展到 Qwen3、Gemma4（未与 Gemma 官方 MTP 对比） |
| 显存开销 | 额外预测头较轻（共享主干 KV cache，比外挂 draft model 省） | 草稿模块更大（多组件），但换来更高接受长度 |
| 独立性/可迁移 | 每家模型自带的头互不通用 | 跨模型框架（Qwen/Gemma 均可训练草稿器），DeepSpec 提供训练全流程 |

另有两个背景事实：其一，DSpark 据称可为华为昇腾等「替代芯片」带来最高 400% 提升（单一方面来源，谨慎采信）；其二，社区在 DGX Spark/GB10 上有 60–67 tok/s 单流提升的实测（注意与「DGX Spark 裸机跑 GPT-OSS 20B 约 60 tok/s」这类无 DSpark 数据区分，两者在传播中常被混为一谈）。

## 五、「哪个更强」的分层答案

- **同条件下比速度**：**DSpark 强**——它就是以 MTP-1 为基线测出 +57%~85%，并在接受长度上压过 Eagle3/DFlash 这两个同代方案。若两者都可用于你的模型和引擎，选 DSpark 没有争议。
- **比可用性与生态**：**MTP 强**——开箱即用、全引擎支持、生产验证充分；DSpark 预览版状态、引擎覆盖有限。
- **比技术定位**：**不是对手，是上下游**——MTP 属于「模型内建多 token 预测/自我起草」这一层；DSpark 属于「服务侧把这类起草做得更聪明的框架」这一层。它代表推测解码的下一代工程化方向（置信度调度 + 硬件感知），MTP-1 则是它用来证明自己的标尺。
- **能否叠加**：不能。DSpark 替换 MTP-1 路径（vLLM-Ascend 的实现是并列提供 dspark / mtp 两条投机路径供选择），无「同时生效」的官方方案。

## 六、置信度说明

1. **高置信**（官方技术报告/论文口径，多来源交叉）：MTP 原理与 1.8× 加速、85–90% 接受率；DSpark 相对 MTP-1 的 57–85%、vs Eagle3/DFlash 的离线数据、五大技术点。
2. **中置信**（单一或媒体来源）：GPU 利用率 1%→15%；昇腾 400% 提升；DGX Spark 社区实测数字。
3. **注意**：DSpark 生产数据全部出自 DeepSeek 自有系统，截至检索时点未见独立第三方复现；DeepSeek-V4 引擎为预览版；「+661%/+406%」是严格 SLA 边界扩展的表述，勿按字面「6 倍」传播。

## 来源列表（三次检索合并精选，按引用价值排序）

**DSpark 官方/技术解析：**
1. DSpark in SGLang: Speculative Decoding with Confidence-Driven, Variable-Length Verification — https://www.lmsys.org/blog/2026-07-06-dspark-sglang
2. DSpark：Confidence-Scheduled Speculative Decoding with Semi-Autoregressive Generation — https://www.36kr.com/p/3871135542416645 （另有新浪转载版 https://www.sina.cn/news/detail/5315457477512508.html）
3. Inside DeepSeek's DSpark: How Speculative Decoding Speeds Up LLM Inference Without Losing Quality — https://deepseek.ai/blog/inside-deepseek-dspark-lossless-inference
4. DeepSeek联合北京大学开源DSpark性能飙升85%不靠堆显卡 — https://k.sina.cn/article_7880068204_1d5b04c6c06801b5du.html
5. DSpark，看懂这10个点就够了！ — https://finance.sina.cn/2026-06-28/detail-iniexymu6294787.d.html
6. Train a DSpark Drafter for Speculative Decoding（NVIDIA NeMo 官方教程） — https://docs.nvidia.com/nemo/automodel/recipes-e2e-examples/dspark-speculative-decoding
7. [RFC] Add DSpark speculative decoding support for DeepSeek-V4 · vllm-ascend Issue #11126 — https://github.com/vllm-project/vllm-ascend/issues/11126
8. DSpark and Gemma 4: What DeepSeek's Speedup Actually Means — https://gemma4all.com/blog/gemma-4-dspark

**MTP 官方/技术解析：**
9. DeepSeek-V3 Technical Report — https://arxiv.org/abs/2412.19437
10. Multi-Token Prediction (MTP)（NVIDIA NeMo 文档） — https://docs.nvidia.com/nemo/megatron-bridge/latest/training/multi-token-prediction.html
11. MTP (Multi-Token Prediction)（vLLM speculators 文档） — https://docs.vllm.ai/projects/speculators/en/latest/user_guide/algorithms/mtp/
12. 十分钟读懂 DeepSeek MTP — https://www.cnblogs.com/gongzb/p/19186955
13. DeepSeek-V3 架构解析 — https://juejin.cn/post/7540877562266320932
14. MTP（MindIE-LLM 昇腾文档） — https://github.com/Ascend/MindIE-LLM/blob/master/docs/zh/user_guide/feature/mtp.md
15. Insights into DeepSeek-V3: Scaling Challenges and Reflections on Hardware — https://www.rivista.ai/wp-content/uploads/2025/07/2505.09343v1.pdf

**背景/对比：**
16. SGLang 与 vLLM 对比 — https://www.cnblogs.com/yisheng163/p/19732523
17. vLLM vs SGLang: A Deep Technical Comparison for Enterprise AI Inference — https://dev.to/ljhao/vllm-vs-sglang-enterprise-llm-inference-comparison-3dg3
18. DeepSeek DSpark 推理加速是什么？速度提升 60%-85% 详解 — https://gpt108.com/blog/deepseek-dspark-inference-acceleration-guide.html
