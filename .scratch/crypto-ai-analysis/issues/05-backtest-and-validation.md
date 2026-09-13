Type: grilling
Status: resolved
Assignee: Codex
Resolved: 2026-09-13

## Question

确定首版回测和验收标准：回测时间范围和粒度、手续费与滑点、信号在何时可见、指标暖机期、是否允许同一根 K 线成交、样本外区间、未来数据泄漏检查、胜率/收益因子/最大回撤/风险收益比等指标，以及什么结果才允许在 UI 中显示为可用信号。

## Answer

完整回测契约已持久化到 [crypto-ai-analysis Acai spec](../../../features/opencharts/crypto-ai-analysis.feature.yaml) 的 `crypto-ai-analysis.VALIDATION.1` 至 `crypto-ai-analysis.VALIDATION.14-1`。

第一版分别回测 6 个首批交易对最近完整 3 年，历史不足时使用 Binance 可获得的全部数据。正式统计前至少加载 250 根 `1d` K 线及对应低周期数据暖机。每个区间按时间顺序使用前 70% 研究、后 30% 样本外验证；`trend-pullback-v1` 不得根据样本外结果改写，调参必须创建新版本并重新验证。

信号只能在 `1h` 确认 K 线闭合后可见，入场最早从下一根 `1h` 开始。无法获知单根 K 线内事件先后时采用保守成交顺序。默认双边手续费均为 0.1%，双边滑点均为 0.05%，全部向不利方向计入。初始净值为 10000 USDT，单笔风险上限 1%，组合风险上限 3%。

TP1 卖出 50%，剩余仓位止损移至包含成本的保本价，再由 TP2 或保本止损退出。同一根 K 线同时触发保本止损和 TP2 时按止损优先。第一版不使用追踪止损，也不允许 AI 决定退出。

报告必须展示单币种、组合和 buy-and-hold 基准的完整绩效与成本指标。单币种样本外至少 20 笔、组合至少 100 笔才算样本足够。样本外组合同时满足至少 100 笔、Profit Factor >= 1.1、最大回撤 <= 25%、净收益为正、至少 4 个币种 Profit Factor >= 1.0，并通过全部未来数据和成交时序测试时，才标记为 `research-usable`；否则为 `experimental`。

`research-usable` 只表示适合继续模拟研究，不代表适合真实交易或保证未来收益。任何未来数据泄漏、时间顺序或可复现性测试失败都会使该次回测变为 `invalid`。
