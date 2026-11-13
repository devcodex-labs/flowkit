# 首发受控 stdio 配置的 G12 P0 验收

首发采用现有 Windows／Linux Codex App Server 受控 stdio，Host 和 Model 以独立普通账户运行。Windows 通过固定回环 SSH 命令和标准流句柄白名单启动，Linux 使用固定启动链和受限 UID／GID。操作员和审计员由受信监督器依据实际 OS 身份绑定。当前配置没有候选 TLS／mTLS IPC 或 Named Pipe，SEC-07／16 为 N/A。启用的 stdio 路径仍按 SEC-05／06 验收。

原生实测提交为 `90e20554ef5ae443fd56a662cea616723c956170`，[起始 CI 8/8](https://github.com/devcodex-labs/flowkit/actions/runs/43424055261)。三份冻结原件与附属材料的字节数和 SHA-256 已按 [G01 登记](../p0a-g01-20261112/verified-inputs.txt) 复核。

## Windows 实测

- `os-stdio` 在固定启动链完成 4 个真实 Codex 回合。核对不同 Host／Model SID、Model 非提升权限及继承的标准流白名单。两个操作员的租户共享 RunId 和 startKey，合法回执分别在 revision 4 接纳，两个 Run 均到达 revision 9。错主体和错租户均返回统一拒绝，零新增签名和 CAS，Checkpoint、Journal、接纳索引不变。
- 离线复核两份原生 tool start／callback、规范参数和 Ed25519 签名，关联两条共 20 行 Journal。该探针中的审计操作由 Host 依据预先核对的身份执行。另用真实普通操作员和审计员的 stdio 会话测试了回复交付、跨租户拒绝、撤权后旧会话失效及新会话恢复，6 个子进程退出 0。两项实测覆盖各自路径的授权，完整的同一 Run 从操作员创建、Model 回执到审计客户端收件仍待证明。
- 复核 E10 四个场景的 8 份 Model 侧原始协议文件，Host 私有合成标记均未出现。完整日志可见性与授权审计路径仍按 SEC-11 裁决。回环监听收尾计数为 0。

```powershell
# windows-run-os.ps1 在普通 Host 身份下启动
node tests/security/codex-flowkit-probe.mjs <codex> <Model工作目录> <新Host私有目录> os-stdio isolated
node <归档目录>/verify-windows.mjs <checkout> <归档目录>
```

`FlowKit-Windows-G12-Selected-Stdio.zip` SHA-256 为 `f5465f52b803e0acaca9b4ac3ff67dd885c9acf9976d2bfd4981e62d9a6404c0`，18 项逐一核对。归档包含实际启动、原始协议、监督器与客户端收件、离线验签及退出状态。证据为 P/M/T。

## 程序级故障恢复

测试提交 `f391fd07ff777a72360726ba7fd091f9aad623f5`，相对原生实测提交的测试 Diff SHA-256 为 `562e1430017b1cbc1cc2698be6b1adb34229fd20fae16086adbd2362985ffc1`。现有 T29 的 12 个真实子进程强停切点增加逐点断言。发布前无已发布 Pending，发布后复用原 requestId 和 revision。接纳前保留原 Pending，接纳后按原 requestId、receivedSubmission 和接纳 revision 核对回执索引。候选提交前后核对 State，每个切点检查 revision 和 Journal 数。Windows Node 22.13.0 和 24.22.2 各通过 9/9，包括既有 Genesis 前后与会话回归。增强范围为 P 级，Host／Model 组合证据沿用 E2–E4、E8、E18。

```powershell
$files = @('tests/interactive/crash.test.mjs','tests/interactive/p0a-ops.test.mjs','tests/interactive/codex-os-access.test.mjs')
volta run --node 22.13.0 node --test @files
node --test @files
```

## Linux 实测

快进拉取同一提交后，固定启动链上的 `os-stdio isolated` 首次退出 0，耗时 16.86 秒。1 个真实 App Server、3 个线程、4 个回合，Host／Model UID 分别为 41001／41002。两租户的有效签名各在 revision 4 接纳，终态均为 revision 9。错主体和错租户均零新增签名、零 CAS；已核对 Journal、审计投影和 EOF 后无遗留进程。离线核验首次把登录状态误判为仅在 stdout，改为检查归档的两路输出后通过，模型验收未重跑。归档保留 bubblewrap／用户命名空间诊断，Codex 内部沙箱和实际 Shell 权限仍待验证。

```sh
git pull --ff-only origin feat/p0a-interactive-20261112
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-release-stdio-controller.mjs attempt-1
```

`FlowKit-Linux-Release-Stdio-20261113.zip` SHA-256 为 `05ea40389d319811720f9d5450995744694a9b2be7b7ada16bf839a0a400418f`。Linux 端核对 165 个载荷文件、ZIP 完整性及逐项哈希。证据为 P/M/T。 [Linux 原始命令、日志和归档](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

## 独立复审与尚缺 P0

**G12 维持 BLOCKED。** 独立复审核对了两端的原生证据和新增恢复断言。SEC-15 按选定 stdio 的两个 OS 主体／两个租户、同 RunId 与 startKey、并发接纳和错租户拒绝通过。供应商故障属于 NAT-10；缺可验证事件时保持 BLOCKED。NAT-13 的供应商签名为可选探测。此次裁决按已选的受控 stdio 与 R5 SQLite 参考配置，外部身份系统、监听 IPC 和额外生产运维能力无需成为该配置的前置条件。

| 仍缺的条款 | 本批已补与待验证 |
| --- | --- |
| SEC-02–04、Linux SEC-17 | E6 与既有 CI 提供普通进程隔离证据。本批记录真实 Model 身份与标准流白名单。完整的实际 Model 句柄／描述符和权限裁决仍待证据。 |
| SEC-05／06、08／09、11；NAT-01／06／07／11 | 两租户的原生回调授权、无写入拒绝和 Model 协议最小披露有证据。完整的启用入口、实际来源拒绝、授权审计交付与披露矩阵仍缺。 |
| SEC-10／T29、S02；T28／T30 | 本批补齐逐切点程序断言。正式选定宿主的组合恢复证据和冻结条款的完整裁决仍开放。 |
| NAT-10／12／14、C12／S13／T27 | 有正向签前事件顺序、受控骤断和同一 Pending 恢复。E11 的迟到、缺失、失配及超时使用单独的回调路径，所选 OS 绑定路径仍待有界拒绝证据。实际会话变更和重新授权、供应商故障与完整来源链仍待证。 |

若能提供一次真实 Codex 供应商故障的原始记录或供应商支持的验证入口，可用于独立复核 NAT-10。首发 stdio 选择已确认。正式发布等适用的 G12 门禁放行与明确授权。
