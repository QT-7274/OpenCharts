Type: grilling
Status: resolved
Assignee: Codex
Resolved: 2026-09-13

## Question

确定分析触发和输入数据规则：手动触发与 `1h` K 线收盘触发是否都保留；`1d`、`4h`、`1h` 的闭合时间如何统一；未闭合 K 线是否只展示不参与正式信号；缺失、重复、异常 OHLCV 如何处理；多周期数据不同步时是延迟分析还是输出“数据不足”。

## Answer

### Trigger model

保留两种正式分析触发方式：

- `manual`：用户主动请求分析；
- `hourly-close`：目标交易对的 `1h` K 线收到 `isClosed === true` 后自动触发。

实时未闭合 K 线只更新价格和图表，不参与指标输入、信号评分、支撑阻力、入场计划或自动分析。自动触发按 `(symbol, 1h openTimeMs)` 保证幂等，重复的闭合事件不得重复生成分析快照。

### As-of alignment

每次分析先确定一个 `analysisTimeMs`：

- 自动触发使用刚闭合 `1h` K 线的 `closeTimeMs`；
- 手动触发使用 Binance server time，但分析输入仍只取该时刻之前已经闭合的 K 线。

对 `1d`、`4h`、`1h` 分别选择满足 `closeTimeMs <= analysisTimeMs` 的最新闭合 K 线及其历史窗口。三个周期不必同时产生新 K 线；较高周期沿用截至分析时点最近的已闭合数据。每份分析快照必须保存 `analysisTimeMs`、触发类型，以及三个周期各自的最新 `closeTimeMs`，避免把高周期旧数据描述成同时闭合。

内部时间统一为 UTC Unix epoch milliseconds。K 线边界采用 Binance 默认 UTC 边界；本地时区只用于界面格式化，不改变 candle identity、闭合判断或策略计算。

### Data validation

进入正式分析前，对每个周期的完整窗口执行以下校验：

- 所有时间和 OHLCV 数值必须有限；`openTimeMs < closeTimeMs`；
- `open`、`high`、`low`、`close` 必须大于零，`volume` 和 `quoteVolume` 不得小于零；
- `high >= max(open, close)`、`low <= min(open, close)` 且 `high >= low`；
- 相邻闭合 K 线必须符合该周期预期边界，不能存在未解释的时间缺口；
- 正式分析窗口中不得包含 `isClosed === false` 的 K 线；
- 每个周期必须满足后续策略票据确定的最小指标暖机数量。

以 `(symbol, interval, openTimeMs)` 为唯一键。相同键下闭合事件优先于未闭合事件；完全相同的重复数据直接忽略。两个闭合版本的 OHLCV 冲突时，不静默选取其中一个：通过 REST 重新读取该时间段并以 REST 结果校正；无法校正则将该周期标记为 `degraded`。

### Missing and stale data

发现缺口后先执行 REST 回填，再重新进行去重和完整性校验。禁止 forward-fill、插值或伪造成交量。回填成功后可以继续本次分析；回填失败、数据仍冲突或任一必需周期缺少完整暖机窗口时，不等待无限重试，也不让 AI 推测缺失内容。

第一版把以下任一情况统一归类为 `insufficient-data`：

- `1d`、`4h`、`1h` 任一必需周期缺失或处于 `degraded`；
- 最新闭合数据晚于当前应有边界超过一个对应周期；
- OHLCV 校验失败且 REST 无法校正；
- 指标暖机数据不足。

`insufficient-data` 仍产生一份可追踪的分析尝试记录，但不得产生交易信号、入场区间、止损止盈或模拟订单。用户结论固定为“暂不入场”，原因固定归入“数据不足或多周期数据不同步”，并附具体缺失周期和数据时间。AI 只能解释该降级原因，不能补全趋势或预测方向。

### Acceptance boundary

后续实现必须通过确定性测试证明：

- 未闭合 K 线不会进入正式指标或信号输入；
- 自动触发对重复的 `1h` 闭合事件保持幂等；
- 手动与自动触发使用同一套 as-of 对齐规则；
- 三个周期使用各自在 `analysisTimeMs` 前最近的闭合数据；
- 缺口回填成功后恢复分析，回填失败后输出 `insufficient-data`；
- 冲突或非法 OHLCV 不会被静默接受；
- 本地显示时区变化不影响 candle identity 和分析结果。
