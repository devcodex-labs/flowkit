# R5 多阶段续跑与受权终态读取

起始 Draft 提交 `a9498ab1d06d66a59b793c761fa4717af45a5e3d`，实测候选 `0d1da06bb3f8e56ebc54a2d32619c83d3cadea34`。候选只扩展两份验收探针。运行使用真实 Codex App Server、分离的普通 Host／Model 账户和全新 SQLite 测试库。工作流和业务数据为合成样本。

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有根> isolated branch-r5
```

## 样本与验收条件

- **多阶段续跑。** 每个真实 Agent 回合先经 `flowkit_continue` 读取同一个 Run 当前的公开任务，再经 `flowkit_submit` 提交该任务的结构化输出。Host 匹配实际工具开始和回调的 thread、turn、call 及规范参数后才签名。需求、设计、计划和审查各接纳一次，后一步只收到当前节点声明的上一步字段。
- **分支。** 分别验证初始条件 `ready=false`、缺少 `ready`、四个 Agent 后真实工具提交 `reviewApproved=false`，以及两个条件都通过。初始拒绝和缺值样本仍有真实开始及读取回合，Run 的 Agent Pending 派发数和接纳数均须为零。模型按测试任务指令提交审查布尔值。
- **受权读取。** 模型只收到终态公开 Frame。探针在模型回合结束后使用 Host 的同一个读取 API，先验证普通权限被拒，再切换到测试用的 Host 审计授权并核对完整 State。权限判定和读取在 Host 私有进程中执行，完整 State 只保存在 Host 观察日志。
- **入口负例。** 真实工具回调带错 requestId 被拒。在另一回合，Host 有意扣留探针的开始事件索引，实际回调因缺观察被拒。两次均对比 Checkpoint、Journal 和接纳索引，确认零签名、零 CAS，随后合法回合接纳同一 Pending。

## Windows 实测

运行 `branch-20261113154026` 退出码 0。已核对两份部署探针的 SHA-256，测试后回环监听数为 0。四个真实 App Server 会话共 18 个模型回合，独立复核 8 份 Ed25519 签名和 4 条完整 Journal 链。Program SHA-256 为 `8174a1dcb733e02b74f2679c9f160b7574e0480c7e0ca6eb1fb9645a51477866`。

| 分支 | 真实回合 | 已接纳 | 终态与 revision | Journal |
|---|---:|---:|---|---:|
| 通过 | 8 | 4 | `succeeded`，34 | 35 |
| 审查拒绝 | 6 | 4 | `failed`，34 | 35 |
| 初始条件 false | 2 | 0 | `failed`，4 | 5 |
| 初始条件缺值 | 2 | 0 | `errored`，2，Host 私有原因 `FK_R002` | 3 |

两组四 Agent 的接纳 revision 均为 6、13、20、27。独立复核关联了八份签名的开始、回调、参数和接纳摘要，核对了两次负例的失败响应和签名数，模型侧协议请求不含 Host 私有标记。

```powershell
& C:\ProgramData\FlowKit-Isolated-Lab\public\node.exe C:\ProgramData\FlowKit-Isolated-Lab\public\source\tests\security\codex-outbox-live.mjs C:\ProgramData\FlowKit-Isolated-Lab\public\codex.exe C:\ProgramData\FlowKit-Isolated-Lab\public\model-work C:\ProgramData\FlowKit-Isolated-Lab\host-private\branch-20261113154026 isolated branch-r5
```

Windows 原始归档 `FlowKit-Windows-Branch-R5-20261113.zip` 的 SHA-256 为 `89eef48d085e44099041700996cea7b50b8b6305f5691e554c3335adcc9e6250`。归档内 33 份文件已逐项复核。原件含启动脚本、监督日志、协议、Host 观察、公开验签钥和可重跑的独立复核脚本。

## Linux 实测

FlowKit 任务先快进拉取同一候选并复核 64 个部署文件。外层控制器启动独立普通 Host 和 Model 账户。四个场景各跑一次，合计 4 个 App Server 会话、18 个真实回合、26 次动态工具回调，正式运行约 142 秒，退出码 0。四组终态、接纳数、revision、Journal 行数和 Program 摘要与 Windows 表一致。独立复核通过 8 份原始 Ed25519 签名、4 条 Journal 链，并核对终态 R5 快照与受权读取返回的 State 一致。

```sh
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-branch-r5-controller.mjs attempt-1
```

Linux 原始归档 `FlowKit-Linux-Branch-R5-20261113.zip` 由 [FlowKit 任务](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable) 保管，SHA-256 为 `9a6bdf89a0b6af3f9d601288c59a5f72a70156f144114e6588bd548644a5f2cd`。Linux 端核对了 ZIP 完整性和 254 份文件的逐项哈希。归档含正式命令和退出码、动态工具协议、终态 R5 快照、签名原字节、案例 CSV 和独立复核脚本。

## 证据边界

本批样本为 P／M／T 级。真实工具上的错误请求和扣留观察仅覆盖已绑定 stdio 会话的拒绝。当前探针固定 namespace 和普通 Model SID／UID，独立主体与跨租户入口隔离仍为 BLOCKED。真实迟到及失配事件、异常退出、完整来源链、生产授权及 G12 独立复审按原矩阵继续取证。定向回归 38/38，[候选 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43387262536) 8/8。
