# R5 Codex 入口的主体、租户与观察时序

Draft 起点 `1eb68a9d6b81a464ef1f5f16fd7c6779efeb967d`，双平台实测候选 `60b745e1708f2e7c10b88254912fa074b9489d3e`。候选增加验收探针及运行入口。启动器核验普通 Model 进程的 OS 身份。Host 用启动时配置把实际 App Server 线程绑定到测试主体和命名空间，回调 JSON 仅提供 `requestId` 和结果。Host 通过私有授权表查找目标并核对当前 Pending、主体、租户以及工具开始和回调的规范参数，随后才生成签名。两租户共用一个 R5 SQLite 文件，使用独立的命名空间、签名钥及私有状态，同用 `entry-shared-run` 和 `entry-shared-start`。R5 §11 规定从受信 Host 会话固定命名空间，正式部署还须提供主体认证来源。

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有根> isolated entry-r5
```

| 样本 | 入口行为和断言 |
|---|---|
| 错主体 | 同租户中 `tester-b` 访问属于 `tester-a` 的 Pending。工具返回统一拒绝。 |
| 错租户 | `tester-b` 的 `tenant-a` 会话提交 `tester-b` 在 `tenant-b` 的 Pending。工具返回同样的统一拒绝。 |
| 观察失配 | Host 故障注入改变观察中的参数值，真实回调保持原样。签前比较拒绝。 |
| 观察超时 | Host 丢弃实际开始事件的索引，收到真实回调后在测试等待上限 500 ms 拒绝。 |
| 观察迟到 | Host 延迟交付已捕获的开始观察，先按同一上限拒绝回调，再丢弃迟到观察。 |
| 两个合法请求 | 每个合法会话提交一次，分别在本租户 revision 4 接纳，终态为 `succeeded`、revision 9，Journal 各 10 行。 |

每个拒绝分别核对 Ed25519 签名计数增量 0、两租户 `compareAndSwap` 调用次数增量 0，并逐行比较两个租户的 Checkpoint 原始 JSON、Journal 和接纳索引。合法样本各产生一份可独立复核的签名和接纳记录。

## Windows 实测

运行 `entry-20261113161559` 退出码 0。独立普通 Host 和 Model 账户，1 个真实 App Server、3 个线程、7 个模型回合和 7 次真实工具回调，样本全部通过。超时样本实际等待 **502.45 ms**，迟到样本先等待 **513.75 ms** 后拒绝，再丢弃迟到观察。独立复核通过两份签名和两条完整 Journal 链，部署探针哈希与候选相同，测试后回环监听数为 0。

```powershell
& C:\ProgramData\FlowKit-Isolated-Lab\public\node.exe C:\ProgramData\FlowKit-Isolated-Lab\public\source\tests\security\codex-outbox-live.mjs C:\ProgramData\FlowKit-Isolated-Lab\public\codex.exe C:\ProgramData\FlowKit-Isolated-Lab\public\model-work C:\ProgramData\FlowKit-Isolated-Lab\host-private\entry-20261113161559 isolated entry-r5
```

原始归档 `FlowKit-Windows-Entry-R5-20261113.zip` 的 SHA-256 为 `bafb386a9f433a644d48f25ba81af0ae9abbe1dd82552005f67616a71aa73d92`。16 份归档文件已逐项复核，含启动脚本、原始协议、Host 观察、签名与公开验证钥和独立复核脚本。

## Linux 实测

FlowKit 先快进拉取候选，验证 64 个部署文件，再从新私有根用独立普通 Host 和 Model 账户运行。首次正式执行约 44 秒，退出码 0。1 个真实 App Server、3 个线程、7 个模型回合和 7 次真实工具回调，全部通过。独立复核了两份原始签名、20 行 Journal 与两个租户的回执索引。超时实际等待 **501.39 ms**，迟到场景 **500.74 ms**，后交付的观察被丢弃。容器和登录保留，测试进程已回收。

```sh
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-entry-r5-controller.mjs attempt-1
```

原始归档 `FlowKit-Linux-Entry-R5-20261113.zip` 的 SHA-256 为 `c47365df7dc2385a7ff5247d289169a048343d35c67879c5f99ee5a5a27d992b`。Linux 端核对了 ZIP 完整性和 161 份文件的逐项哈希。归档由 [FlowKit 任务](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable) 保管，含原始日志、SQL 快照、两份签名及公钥、精确命令和独立复核脚本。

## 尚待验收

本轮 P／M／T 证据来自真实 Codex 工具回调、测试主体绑定和 Host 侧故障注入。生产身份源、两个实际登录主体、实际审计主体、文件入口同等授权、并发租户操作及原生供应商时序异常仍为 BLOCKED。两租户同时存在且顺序提交。500 ms 仅用于测试，部署等待策略待实际运行数据确认。未改 Core、ABI 或 Store schema。Host、SQLite Store 和 Outbox 定向回归 32/32，[实测候选 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43391860952) 8/8。
