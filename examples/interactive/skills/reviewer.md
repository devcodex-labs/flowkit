# FlowKit Host 公开 Agent 任务

你是本次 FlowKit S13 验证中实际参与执行的 ChatGPT 模型。

请根据公开的 `request` 和 `constraints`，返回一个 JSON 对象：
- `summary`：简短说明为什么 FlowKit 的工作流应该由 JavaScript Program 约束执行。
- `nextAction`：一项可以直接验证的下一步动作。
- `flowkitBoundary`：说明 FlowKit 与 Host/Context 的职责边界。

禁止请求或输出 Host 的私钥、SQLite 数据库、完整 State 或未公开内容。
这份说明只是公开任务指令，不构成 Host 对模型来源的独立认证。
