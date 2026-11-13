# Windows 原生回合取消后续跑

基线 `97d01bbca46b2b605f7977e38d2b52756cef02c5` 的 [CI](https://github.com/devcodex-labs/flowkit/actions/runs/43438819472) 为 8/8。实测代码候选 `1d2d216e919a9d5aa5874123542682e4bca5105a`，增量 Diff SHA-256 为 `37a659c5bf4ae5747976202f1cc76f7c61ae18781424a6211ae1d394b44c5000`。Requirements V0.3、Technical Design V0.6-R5、P0-A V0.1 及三份附属原件字节数和 SHA-256 均与 [G01 冻结登记](../p0a-g01-20261112/verified-inputs.txt) 一致。代码变更限于验收探针。

## Windows 受控取消与续跑

普通操作员创建 `chain-055bfff334f84ce5abfac52b4029978e` 并收到 revision 3 的 Pending。第一个真实 App Server 回合进入只读测试工具等待点。Host 从原生 stdio 收到匹配的工具开始事件与回调，调用标准 `turn/interrupt` 并收到匹配响应，回合状态为 `interrupted`。Host 对比 SQLite Checkpoint、Journal、回执索引、签名次数和 CAS 次数，确认状态不变、零签名、零 CAS，公开任务仍是原 Pending。本次从观察到工具等待到核对 Pending 保留用时 4 ms。

同一个 App Server 和线程启动第二回合，回调提交原 `requestId`，唯一有效签名在 revision 4 接纳。Run 到达 revision 9，审计员进程收到同一终态，操作员读取被拒。独立复核关联两回合、原始工具事件与取消响应、签名与回执索引、10 条 Journal 哈希链及实际审计员收件。Model 双向协议均未出现私有租户标记。三普通进程退出 0，探针退出 0，回环监听清理后为 0。证据为 P/M/T，覆盖受控取消后的续跑。

```powershell
windows-deploy-and-run.ps1 -Output <归档目录>
windows-os-chain.ps1 -RunName <本次Run目录> -Output <归档目录>
node tests/security/codex-flowkit-probe.mjs <codex> <Model工作目录> <新Host私有目录> os-chain-recovery isolated
node <归档目录>/verify-windows-recovery.mjs <checkout> <归档目录>
```

Windows Node 22.13.0 与 24.22.2 定向回归各通过 8/8。`FlowKit-Windows-G12-Native-Recovery.zip` SHA-256 为 `e24acdda9a67aec0e447b6ef60c3c4db35e2f5dd1257abdab8301290d5d80b8c`，逐项核对 21 个文件，包含原始双向协议、OS 会话收件、命令、退出、SHA-256 和离线复核输出。

## Linux 供给与裁决

FlowKit 核对了托管环境及管理入口。共享执行器为 UID 1000、零有效 capabilities、无 `sudo`，可见的 Cloud 配置未提供专用 Linux VM 或创建普通账户的管理员入口。既有容器的沙箱限制沿用 E23。待提供已启动、支持正常 Codex 命令沙箱的专用 Linux 验收环境和平台认可的管理员执行入口。环境可用后可按现有授权配置普通 Host／Model 和受信启动器，再核对 Model 登录。当前未配置账户、未触发条件性 pull，Linux 同链复跑为 BLOCKED。

`FlowKit-Linux-Provisioning-Entry-Gate-20261113-final.zip` SHA-256 为 `3e53bc7c6e95f2b7e694f3609aa7fc7920d4a0d1f9d9982c3576386696d42b09`，Linux 端核对 8 个载荷文件。 [Linux 供给盘点、原始命令与归档](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

**NAT-14 完整验收和 G12 维持 BLOCKED。** E22 提供观察异常的 P 级证据。本批原生样本在已收到有效观察后主动取消。缺失、迟到或失配观察后有界结束并在实际 App Server 接纳原 Pending 的证据仍缺。供应商故障、Linux 双账户命令沙箱及 Linux 同链验收仍待补。
