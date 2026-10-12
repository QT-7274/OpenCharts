# AI Agent Integration Research

Research date: 2026-10-09

## Recommendation

Recommend **shared domain functions plus a thin MCP adapter**. Start with local `stdio` for a same-user agent; add REST/OpenAPI when the UI and scripts also need a backend API. For remote agents, use authenticated Streamable HTTP or a supported secure tunnel. This is a fit recommendation, not an adoption ranking. [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [OpenAI MCP integration](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)

The [project README](../README.md) describes an in-browser paper-trading engine and REST-shaped facade. This does not establish an externally callable API: first make analysis/backtest operations callable without rendering the UI, and define who owns any shared paper-account state.

## Options

| Option | What it standardizes | Fit for this project |
| --- | --- | --- |
| **REST + OpenAPI** | Application-to-application HTTP endpoints and a language-neutral description of their inputs and outputs. | Good durable API if the UI, scripts, and multiple agent runtimes should share the same backend. OpenAPI describes HTTP APIs; it does not itself provide an agent tool-discovery or model orchestration loop. [OpenAPI Specification](https://spec.openapis.org/oas/v3.2.1.html) |
| **MCP** | A host/agent's connection to tools and context. Servers publish callable tools with input/output schemas; clients discover and invoke them. | Best default agent boundary for local analysis and backtesting. It is portable across MCP-capable hosts and supports both client-launched local `stdio` and HTTP transport. The protocol does not require a particular user interaction model, so keep confirmation and authorization explicit in the host/server. [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) |
| **Model function calling** | A model-provider API's JSON-schema function definitions and the application-owned loop that executes returned calls and sends results back to the model. | Simplest when OpenCharts owns one specific model integration. It is not a general cross-agent protocol; the application must implement the execution loop and provider adapter. [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) |
| **A2A** | Communication, discovery, and task delegation between independent agents, including asynchronous and long-running work. | Not needed just to let an existing agent query OpenCharts. Consider it only if OpenCharts later becomes an autonomous specialist agent that other agents delegate work to. A2A describes its relationship with MCP as complementary: A2A connects agents, MCP connects an agent to tools/data. [A2A overview](https://a2a-protocol.org/latest/topics/what-is-a2a/), [A2A specification](https://a2a-protocol.org/latest/specification/) |

## Suggested Shape

1. Keep deterministic analysis, indicator, backtest, and paper-account logic in a domain layer callable without rendering the UI.
2. Start with queries and research jobs: `get_market_snapshot`, `analyze_symbol`, `run_backtest`, and `get_backtest_report` are proposed names, not existing tools. A backtest that creates a job/report is not strictly read-only. Bound its date range and resource use; return a job ID for long runs, with status and report retrieval. Return structured results with data provenance, strategy/version, costs, test window, and validation status. Deterministic code computes indicators and metrics; the model explains them.
3. If other non-agent clients need the same capability, add versioned REST endpoints and an OpenAPI description over that domain layer; have MCP call the same functions rather than duplicate business logic.
4. Keep all exchange-account credentials and real-order capabilities out of the first agent integration. If paper-order tools are added later, keep them separate, constrained to the simulated account, and confirmation-gated.

## Security Boundary

The MCP specification recommends a human who can deny tool calls and asks applications to show exposed tools, invocation indicators, and confirmation prompts. Tool annotations are untrusted unless their server is trusted. [MCP tool safety guidance](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

For local use, prefer `stdio` with an explicitly configured local process and a small tool allowlist. For remote access, require authentication and authorization at the server; the MCP authorization spec says servers must only accept tokens issued for their own resources and must not accept or forward other tokens. Use a secure tunnel instead of publishing a private server directly where appropriate. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [OpenAI MCP and Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)

These are integration recommendations, not implemented capabilities. Protocol choice does not validate backtest correctness, Sharpe calculations, or resistance to overfitting; those remain separate research tasks.
