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

## Linux 隔离双账户条件

托管执行器的普通 UID 1000 执行 `/opt/codex/bin/codex sandbox /usr/bin/true` 退出 0，仍缺专用 Model 账户、受管启动器和独立登录。现有容器的 Host 41001 与 Model 41002 独立，Model 登录有效，命令沙箱仍因无法创建用户命名空间退出 1。两项能力尚未在同一候选环境齐备，条件性拉取未触发。Linux checkout 仍为 `2594511d058da47f8cad43e57de48c23db8abf0e`。隔离双账户沙箱及本轮 Linux 同链验收为 BLOCKED。

```sh
/opt/codex/bin/codex sandbox /usr/bin/true
docker --host=unix:///var/run/docker.sock exec --user 41002:41002 flowkit-linux-20261113 /usr/local/bin/flowkit-model-account status
docker --host=unix:///var/run/docker.sock exec --user 41002:41002 --env HOME=/home/fkmodel --env CODEX_HOME=/home/fkmodel/.codex --workdir /model-work flowkit-linux-20261113 /usr/local/bin/codex sandbox /usr/bin/true
```

`FlowKit-Linux-Managed-Dual-Account-Readiness-20261113.zip` SHA-256 为 `24a339fe78ce28457fcf53eec8808d66fc2c83891fbfbd21f2e884b78b978e88`。 [Linux 命令、退出码与原始证据](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

## 裁决

独立角色审查了 `os-chain` 的测试范围、受信监督器和首次启动问题。Windows 同一 Run 正向链通过。**NAT-14 原生异常恢复和 G12 仍为 BLOCKED**。E22 保留原 Pending 并在下一模拟回合接纳的 P 级证据有效，本批真实回合仅覆盖正常观察顺序。待补原生异常后有界结束及原 Pending 后续接纳、Linux 隔离双账户的实际命令沙箱、完整授权及披露范围和供应商故障证据。
