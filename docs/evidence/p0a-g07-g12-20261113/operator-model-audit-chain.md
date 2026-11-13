# 同一 Run 的操作员、Codex 与审计员联测

基线 `122c6f51386ed1fd703ac2d10f5763880c2ad4cc` 的 [CI](https://github.com/devcodex-labs/flowkit/actions/runs/43436840381) 为 8/8。代码候选为 `8667704a79bd8f572ace969d48c5ef49d1add3ac`，增量 Diff SHA-256 为 `7a9c6f85aa08acec44df2b12e97f3c105b71e784faff2b6918710e0166ecb1d3`。Requirements V0.3、Technical Design V0.6-R5、P0-A V0.1 和三份附属材料的字节数及 SHA-256 均与 [G01 冻结登记](../p0a-g01-20261112/verified-inputs.txt) 一致。代码变更限于验收探针。

## Windows 同一 Run

普通 Host、Model、操作员及审计员使用不同 Windows SID。受信监督器核对实际对端 PID 和 SID，在 Host 私有标准流中绑定操作员与审计员的 OS 身份。测试对端进程从各自标准流发送测试命令并确认收件。操作员的 `run:create` 创建 `chain-22fb3e5457cc4425b054fe71a65fa80e`，收件为 `waiting`，revision 3。真实 Codex App Server 提交这个 Run 的当前 `requestId`，独立校验工具开始事件与回调匹配、签名有效，回执在 revision 4 接纳。同一 Run 达到 revision 9，十行 Journal 的哈希链复算一致。

操作员读取终态被拒绝，审计员进程收到同一 `runId` 的授权终态，包含 `answer: "ready"`。真实 Model 协议未出现私有 `tenantMarker`。三个受监督器启动的普通进程退出 0，实验室回环监听清理后为 0。该 Windows 正向样本为 P/M/T。监督器提供测试命令并转发字节，首发完整拒绝范围和披露矩阵仍按 SEC-05／11 裁决。

```powershell
windows-deploy-and-run.ps1 -Output <归档目录>
windows-os-chain.ps1 -RunName <本次Run目录> -Output <归档目录>
node tests/security/codex-flowkit-probe.mjs <codex> <Model工作目录> <新Host私有目录> os-chain isolated
node <归档目录>/verify-windows-chain.mjs <checkout> <归档目录>
```

第一次启动遗漏 `RunName` 参数声明，Host 创建证据目录时返回 `EINVAL`。保留第一次退出 1 的原始日志，补齐并校验参数后复跑，同一代码候选退出 0。复跑的标准错误记录一次模型列表刷新超时，正式回合、签收及审计链完成。Windows Node 22.13.0 与 24.22.2 的定向回归各通过 8/8。`FlowKit-Windows-G12-Operator-Audit.zip` SHA-256 为 `f331c89026084c2bfd50915a42f918ca43f4c026c6e665f56891f16f1c5a0f19`，逐项核对 26 个归档文件。

## Linux 同一 Run

FlowKit 先快进拉取并核对 `5842586a049364fcecc1f8b60df3ba40d5aa90df`，同步验证 75 个测试源文件，复用专用容器内普通 Host UID 41001、已登录 Model UID 41002 和固定 stdio 启动链。受信监督器核对实际普通操作员及审计员进程，将各自的命令转发至 Host 私有 stdio，并记录对端收件。

`chain-aaaf1a243271417d9408b1e600a31d6e` 的操作员收到 revision 3 的等待态。真实 Codex App Server 产生匹配的工具开始与回调，Host 的唯一签名回执在 revision 4 接纳。审计员进程收到同一 Run 的 revision 9 终态，操作员读取被拒。两次读取前后的 SQLite 快照一致。离线复核通过同一 requestId、Ed25519 签名、回执索引、十条 Journal 哈希链和实际收件。监督器首次运行退出 0，耗时 7.94 秒。离线核验退出 0，Host、Model 和测试对端均已回收。样本为 P/M/T。

```sh
git -C /workspace/flowkit-linux-test pull --ff-only origin feat/p0a-interactive-20261112
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-os-chain-controller.mjs
node deliverables/scripts/verify-os-chain-public.mjs "$PWD"
```

`FlowKit-Linux-OS-Chain-5842586-20261114.zip` SHA-256 为 `6cde468e651cf36879051b34588a124b8b717f020cc3aa121044125aee96510e`。Linux 端核对 156 个载荷文件与 ZIP 完整性。归档包含真实启动命令、退出码、两向原始协议、普通进程收件、只读快照与逐项 SHA-256。 [Linux 原始记录及归档](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

Linux 命令沙箱 SEC-17 维持 BLOCKED，沿用既有容器的用户命名空间诊断。本轮按已确认范围执行同链实测。早先的环境核对归档 `FlowKit-Linux-Managed-Dual-Account-Readiness-20261113.zip` SHA-256 为 `24a339fe78ce28457fcf53eec8808d66fc2c83891fbfbd21f2e884b78b978e88`。

## 裁决

**Windows／Linux 同一 Run 正向链通过。** Windows 由独立角色复审，Linux 通过离线验签、哈希链及收件复核。NAT-14 原生异常恢复和 G12 仍为 BLOCKED，剩余门禁见 [发布矩阵](./release-matrix.md)。
