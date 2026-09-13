Type: grilling
Status: resolved
Assignee: Codex
Resolved: 2026-09-13

## Question

确定 AI 分析契约：模型接收哪些结构化指标和行情上下文；输出哪些字段；如何区分算法事实、模型解释和不确定性；如何保证模型不能改写算法数值；模型失败、超时、返回非法 JSON 或信号为“暂不入场”时如何降级；是否保存输入、输出、模型版本和时间戳作为分析快照。

## Answer

完整 AI 契约已持久化到 [crypto-ai-analysis Acai spec](../../../features/opencharts/crypto-ai-analysis.feature.yaml)：

- `crypto-ai-analysis.AI_EXPLANATION.1` 至 `crypto-ai-analysis.AI_EXPLANATION.9-2` 定义后端 provider、输入白名单、Structured Outputs schema、事实保护、失败降级、幂等和成本限制；
- `crypto-ai-analysis.ANALYSIS_SNAPSHOT.1` 至 `crypto-ai-analysis.ANALYSIS_SNAPSHOT.3` 定义可追溯快照、隐私和保留规则；
- `crypto-ai-analysis.ANALYSIS_OUTPUT.3` 保证所有交易数值由确定性算法产生。

第一版前端只调用项目后端，由可替换的 provider 使用 OpenAI Responses API。模型 ID 保持可配置，secret 不进入前端。模型只收到通过数据质量检查的算法摘要，不接收原始 K 线历史，不使用联网搜索或工具获取额外行情。

模型输出使用 strict Structured Outputs，只含解释文字；状态、评分、价位、风险收益比和置信度由界面直接读取算法结果。应用层还要检查 AI 文本中的数字，发现新增或冲突数字时整份解释作废。

AI 操作总超时 15 秒且最多重试一次。超时、拒答、响应不完整、schema 错误或数字冲突都只降级 AI 区域，不改变算法结果。相同分析默认复用解释，只有用户明确重新生成时才再次调用；自动调用每日软上限 50 次，单次输出上限默认 1000 tokens。

每份快照保存算法摘要与结果、策略、prompt 和 schema 版本、provider、完整模型 ID、时间、token usage、原始结构化响应及校验结果，但不保存 secret。OpenAI 请求设置 `store: false`，本地快照默认保留到用户主动删除。

官方设计依据：[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 推荐在需要结构化模型响应时使用 strict JSON schema，并显式处理拒答与不完整响应。
