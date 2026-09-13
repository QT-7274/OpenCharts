Type: grilling
Status: resolved
Assignee: Codex
Resolved: 2026-09-13

## Question

把“多周期趋势 + 回调确认”定义成可复现策略：明确趋势状态、回调状态、入场触发、指标参数、评分权重、指标冲突处理、支撑阻力计算、入场区间、失效条件和“暂不入场”规则。所有数值必须由确定性算法产生，不能由模型自由发挥。

## Answer

完整、可执行的策略定义已持久化到 [crypto-ai-analysis Acai spec](../../../features/opencharts/crypto-ai-analysis.feature.yaml)，后续实现和测试必须引用其中的稳定 ACID：

- `crypto-ai-analysis.STRATEGY.1` 至 `crypto-ai-analysis.STRATEGY.18`：多周期趋势、回调、1h 确认、状态优先级、100 分评分和 `trend-pullback-v1` 版本规则；
- `crypto-ai-analysis.ENTRY_PLAN.1` 至 `crypto-ai-analysis.ENTRY_PLAN.5-1`：支撑阻力、入场区间、结构与 ATR 止损、两级止盈和计划失效；
- `crypto-ai-analysis.ANALYSIS_OUTPUT.1` 至 `crypto-ai-analysis.ANALYSIS_OUTPUT.4-1`：确定性输出、“暂不入场”和置信度语义；
- `crypto-ai-analysis.RISK_AND_PAPER_TRADING.2` 至 `crypto-ai-analysis.RISK_AND_PAPER_TRADING.4`：1% 风险、最低 1:2 风险收益比及用户确认边界。

第一版只寻找现货做多机会。策略先应用数据、趋势和结构硬门槛，再计算证据评分；只有硬条件全部满足、评分至少 70 且风险收益比至少 1:2 才进入 `enter`。价格突破入场区间上沿时不追涨，也不立即取消计划，而是在最多 3 根已闭合 `1h` K 线内等待回落；趋势、回调结构或数据质量失效则立即取消。

这些参数是可调整的基线，但任何调整必须创建新策略版本，不能改写旧快照和旧回测所引用的 `trend-pullback-v1` 含义。
