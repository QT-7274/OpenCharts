## Destination

形成一份可直接交给实现阶段的 OpenCharts 加密货币现货 AI 分析规格：基于真实实时 OHLCV，在 `1d + 4h + 1h` 多周期上计算技术指标和条件式入场计划，由 AI 解释结果并联动模拟交易，同时具备基础回测、分析快照和风险边界。

## Notes

领域：加密货币现货技术分析与模拟交易。

约束：首版面向个人研究；不自动下单；算法产生可验证的指标、信号和风险数值，AI 只负责综合解释；优先复用 OpenCharts 现有图表、指标、行情 facade、WebSocket client 和 paper engine。

工作流：先完成本地图中的决策票据，再进入实现计划。已确认行为持续写入 [crypto-ai-analysis Acai spec](../../features/opencharts/crypto-ai-analysis.feature.yaml)，其稳定 ACID 是后续实现与测试的需求来源；Acai 远端当前不可用，恢复后执行 `acai push --all`。

## Decisions so far

- 已确定产品目的地：个人研究工具，第一阶段只做模拟交易。
- 已确定市场：加密货币现货；首批沿用 BTC、ETH、SOL、BNB、XRP、ADA。
- [实时行情接入契约](issues/01-market-data-realtime-contract.md)：Binance Spot public REST + WebSocket 作为第一版行情源，统一 UTC 毫秒 K 线模型，并由 adapter 负责闭合判定、重连、去重和缺口回填。
- [分析触发与 K 线质量规则](issues/02-analysis-trigger-and-candle-quality.md)：保留手动与 `1h` 闭合自动触发，按 analysis-time 对齐三个周期；缺口或异常无法修复时固定降级为“暂不入场”。
- 已确定分析周期：`1d + 4h + 1h` 多周期波段分析。
- 已确定责任边界：程序计算指标、评分、价位和风险参数；AI 解释，不修改基础数值。
- [可复现的多周期趋势回调策略](issues/03-signal-strategy-definition.md)：`trend-pullback-v1` 已确定趋势、回调、1h 确认、评分、支撑阻力、入场、止损止盈和计划失效规则，后续调参必须新建版本。
- [AI 解释与快照契约](issues/04-ai-analysis-contract.md)：后端以可替换 provider 生成严格结构化解释，算法数值不可覆盖；失败只降级 AI 区域，并保留可追溯、无 secret 的本地快照。
- 已确定输出范围：趋势、指标证据、支撑阻力、入场区间、失效条件、止损、止盈、风险收益比、置信度，以及指标冲突时的“暂不入场”。
- 已确定风险边界：单笔风险默认不超过净值 `1%`，最低风险收益比 `1:2`，止损结合结构位和 ATR，AI 不自动提交订单。
- [回测与研究可用性标准](issues/05-backtest-and-validation.md)：最近 3 年与 70/30 时间切分、保守成交顺序、成本和组合风险、分批退出、报告指标、基准比较、样本门槛及防未来数据泄漏测试均已固定。

## Not yet specified

- 分析面板的交互流程、数据来源标记、历史快照管理和模拟订单联动方式。
- 股票之外的市场、永续合约、自动交易、真实券商连接和公开投顾能力。

## Out of scope

- 第一阶段不支持永续合约、杠杆、资金费率、持仓量和强平分析。
- 第一阶段不连接真实券商，不执行真实订单，不提供自动交易。
- 第一阶段不把截图识别作为主要分析路径。
- 第一阶段不承诺预测涨跌或收益，不将 AI 输出视为投资建议。
