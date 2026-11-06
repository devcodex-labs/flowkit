# 更新记录

## 1.0.0

FlowKit 的首个正式版本。

- 用 JavaScript / TypeScript 字面量 DSL 定义工作流，支持 Agent、业务动作、验证、并行、条件、循环、人工审批和终点。
- 静态检查流程结构、数据声明、Skill 引用及受限条件表达式，输出可读 JavaScript 和 Mermaid。
- 提供 run、compile、compileSource、check、evalWhen、isControlSignal，以及 compile/check 命令行。
- 通过宿主 Runtime 执行业务；支持本地和受限制的 HTTPS Skill、结果校验与重试、跟踪、取消信号及 AOT 一致性检查。
- 提供详细中文文档、完整确定性示例和 MIT 许可证。

需要 Node.js 22.13.0 或更高版本。FlowKit 不内置模型服务、Schema 校验器或持久化审批服务；这些能力由宿主提供。并行分支共享状态，any 汇合不会取消其他分支；AOT 部署仍需保留原始源码和对应 Skill。

[文档](https://devcodex-labs.github.io/flowkit/) · [npm](https://www.npmjs.com/package/@devcodex/flowkit) · [许可证](LICENSE)
