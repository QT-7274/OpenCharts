Type: prototype
Status: open
Assignee: Codex

## Question

做一个低成本分析面板原型，确定用户从选币、选择周期、触发分析、查看指标证据、阅读 AI 解释、检查风险参数、保存快照到带入模拟订单的完整流程。原型需明确实时状态、数据来源、分析时间、信号有效期和“暂不入场”状态如何呈现。

## Context

- Branch: `prototype/crypto-ai-analysis-panel`
- Route: `/prototype/crypto-ai-analysis?variant=A|B|C&state=enter|setup|insufficient`
- Local URL: `http://127.0.0.1:4174/prototype/crypto-ai-analysis?variant=A&state=enter`
- Variants: A 图表旁检查；B 决策工作台；C 流程时间线
- Validation: `npm run build` passes; browser matrix checked manually for B/C and data-gap semantics
- Status: open until the user selects A, B, C, or a hybrid
