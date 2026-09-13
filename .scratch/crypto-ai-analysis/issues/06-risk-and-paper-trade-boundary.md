Type: grilling
Status: resolved
Assignee: Codex
Resolved: 2026-09-13

## Question

确定分析结果与模拟交易的边界：默认单笔风险 `1%`、最低风险收益比 `1:2`、ATR 与结构位如何共同决定止损、仓位如何由风险金额计算、现货不可做空时如何表达看跌结论、模拟订单是否允许一键带入计划参数，以及哪些情况下必须禁止下单或要求用户二次确认。

## Answer

完整模拟交易风险契约已持久化到 [crypto-ai-analysis Acai spec](../../../features/opencharts/crypto-ai-analysis.feature.yaml) 的 `crypto-ai-analysis.RISK_AND_PAPER_TRADING.1` 至 `crypto-ai-analysis.RISK_AND_PAPER_TRADING.11-1`。

仓位由“当前模拟净值的 1% 风险金额 / 入场价与止损价之差”确定，再受可用 USDT 限制并按交易对精度向下取整。资金不足时只能缩小仓位，不能放宽止损；模拟账户不允许借款、负余额或杠杆。

只有 `enter` 状态可以把交易对、入场区间、参考价、数量、止损、TP1、TP2、策略版本和快照 ID 带入模拟订单表单。带入不等于提交，用户必须在列出风险金额、成本、回测状态和有效期的确认框中再次确认。

状态不合格、计划过期、数据异常、风险收益比不足、参数非法、超出单笔或组合风险、资金不足、同币种已有仓位或回测为 `invalid` 时，系统必须禁止订单操作。`experimental` 仍可用于模拟研究，但每次提交都显示不可关闭的研究门槛提示并记录当时状态。

现货首版不生成做空计划。看跌时只显示 `avoid` 与“暂不入场，等待多头条件重新建立”；下方支撑位只能作为观察信息，不能作为做空目标。

创建订单时复制不可变的分析计划并引用原 `snapshotId` 和 `strategyVersion`。新分析不能修改旧订单；未成交前计划失效会自动取消挂单，已经成交的仓位继续执行创建时的止损止盈规则，AI 不得修改。
