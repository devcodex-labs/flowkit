# 参与贡献

FlowKit 为私有专有项目，仅允许经过授权的协作者提交问题、文档改进和实现修复。用户和集成者的使用说明见 README.md 与网站；[中文贡献文档](https://devcodex-labs.github.io/flowkit/community/contributing.html)提供本地准备与文档维护方法。根目录 [AGENTS.md](AGENTS.md) 只记录长期架构与核心契约，本文件是工程协作和合并流程的权威入口。

## 职责与授权

- 项目所有者确定产品目标、架构、需求范围、例外及发布授权。
- Chat 开发：分析、需求与架构审查、方案、实现和测试，在 `develop` 提交变更并发起 PR；根据审查反馈修复，不直接写入 `main`，不自行合并。
- Work 独立审查：从准确 Base/Head 独立检出，复核需求、架构、必要性、Diff、反例、实际构建和测试；核对 CI 和真实 Host 证据。对于所有者已授权且全部门禁满足的 PR，可决定并执行合并；没有持续或本次授权时先取得明确授权。存在范围变化、证据缺口、安全例外或发布操作时交回所有者。Work 可以构造临时反例；如需提交实质修复，由 Chat 接手，或由独立审查方重新验证。
- GitHub Actions 提供自动化验证证据，不替代独立审查、真实业务验收及用户授权。不同会话/模式不自动成为不同 GitHub 身份；同账号不得把自审评论冒充独立 Approve，不绕过已启用的审批门禁。

## 分支与提交

- `main` 为经审查验证的主线；`develop` 为长期开发分支，默认每次只推进一个获批准的批次、一个 `develop -> main` PR。开始前确认两分支准确 SHA、当前架构规则、授权范围及在途改动；若已有未审变更或基线漂移，先解决，不混入其它任务。
- 使用 Conventional Commits，提交标题和正文不写 PR 编号、链接或 PR 关联说明。问题编号、证据和 PR 关系可写在 PR 描述及审查评论。默认以 merge commit 合并，明确提供不含 PR 关联的合并标题和正文，保留 develop 祖先关系。
- Work 合并后核对 main 的提交与 Tree、main CI，以及没有新增未审提交的 develop；将 develop 非强制 fast-forward 到 main。不要直接 push main、force push、重写或删除长期分支。如果 main 回归失败，停止下一批，保留证据，通过经审查的修正或 revert PR 纠正。
- 建议管理员为 main 配置 PR、必需 CI、最新基线、解决审查对话、禁止直接/强制推送及未授权绕过；develop 禁止强制推送和意外删除。采用 merge commit 时不同时强制 linear history。独立 GitHub 审批要求须有真实符合条件的 reviewer。实际设置与权限以仓库读取和验证结果为准；保护未验证或未生效时如实报告，不能把书面规则当作技术强制，也不擅自修改仓库设置。

## 审查、复验与合并门禁

1. 确认已批准问题、适用场景、项目定位、源码证据、合理性、必要性、替代方案、影响范围、非目标和关闭条件。区分确定缺陷、条件修复、架构决定、验收补证及保留事项；无必要不新增机制。相关公开行为变化须同时核对实现、类型、测试、示例、Skill、Provider、文档和实际包。
2. Chat 提交最小实现、相应正反例及文档调整。PR 写明 Base/Head/Tree、问题与实际修改、复现条件、执行命令/退出码、CI run/job、未执行项、风险及回滚建议。未执行的测试不得声称通过。
3. Work 从独立隔离环境核对原始基线规则及候选 Diff，尤其先审查候选安装、构建、测试、CI 和权限变更，再执行。使用低权限、锁定依赖、无生产数据和发布密钥的环境；真实模型/Host 验证须获授权，敏感证据保存在获授权的位置。候选不得通过修改自己的门禁、降低断言或省略必需反例取得通过。
4. 核对精确 PR Head、最新 Base、实际测试的合并 Commit/Tree、CI run/attempt 及所有必要状态检查。Work 记录具体问题、必要性与验证要求；失败退回 Chat。新的 Head 或 Base 使受影响的旧证据失效，须重新审查和验证；没有运行环境或关键证据则明确阻断，不把 fixture 或绿色 CI 当作全部真实验收。
5. 合并前再次核对批准范围、独立审查、真实权限、分支保护、mergeable 状态、必需测试与精确 Head/Base。用预期 Head SHA 防止已审 Head 漂移；它不保证 Base 不变，须同时使用真实最新基线门禁或独占合并窗口。无法满足门禁或核实保护时由所有者裁定，不伪造审批、不使用 admin bypass。合并后核对实际 main Tree 与受验合并 Tree，若不同则查明差异并复验，再检查 main CI、同步 develop、更新台账。
6. 局部 PR 可合并不等于专项关闭、产品可用或版本可发布。剩余跨批依赖及未完成实测明确登记，已知新安全回归不得延期。只有所有者另行授权才执行发布、Tag、部署、真实业务写入或数据清理。

## 本地验证

SDK 使用 Node >=22.13.0；同时开发文档站使用 Node >=24。在仓库根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix website ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run docs:check
npm run docs:examples
npm run docs:build
```

根据改动选择必要的定向、跨平台、包、浏览器、安全及真实 Host 验证。现有 CI 在 PR、main push 等事件运行；普通 develop push 不代表 CI 已运行。生成产物使用 `npm run build` 与 `npm run update:goldens` 更新，不手改 header。普通文档改字无需机械更新 golden。

使用 `npm run docs:dev` 编辑站点。示例主源位于 `examples/docs/`；修改后运行 `npm run docs:sync` 同步 README，再验证消费者。页面使用完整可执行文件、准确输出、错误恢复和相关链接；不要复制私有模块或提交临时日志。

## 问题报告与发布

问题报告请附 Node/npm/系统、FlowKit 版本、最小 workflow/host/Skill、配置、命令与退出码、期望和实际结果。删除密钥、用户数据和不必要业务内容。项目使用 [专有授权协议](LICENSE)，访问私有仓库不自动取得再分发权利。发布由维护者在另行授权后按[发布说明](https://devcodex-labs.github.io/flowkit/maintainers/releasing.html)执行。
