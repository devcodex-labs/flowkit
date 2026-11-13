# 受控 stdio 拒绝后保留 Pending

基线 `e4d6128a9fe9618313dbc966638840e6e54eb03f` 的 [CI](https://github.com/devcodex-labs/flowkit/actions/runs/43434017732) 为 8/8。代码候选为 `2594511d058da47f8cad43e57de48c23db8abf0e`。增量 Diff 的 SHA-256 为 `365984224f2aab5f6556d6ecfc3c7b46d04705a16f97c77e7764fc96e67632a4`。Requirements V0.3、Technical Design V0.6-R5、P0-A V0.1 和三份附属材料的字节数及 SHA-256 均与 [G01 冻结登记](../p0a-g01-20261112/verified-inputs.txt) 一致。

## 复验范围

受控 stdio 探针和程序回归使用同一个观察派发函数。程序回归使用合成的回合记录、真实 SQLite Store、测试签名密钥和 `TrustedInteractiveHost`。未绑定回合、缺失观察、迟到观察和参数失配各自同步返回 `REQUEST_DENIED`。四次拒绝后，签名数和 CAS 调用数无新增，Checkpoint、Journal 和回执索引相同，公开任务仍为原 Pending。下一模拟回合的匹配观察只签名一次，接纳同一个 `requestId`，写入回执索引并到达终态。证据为 P。

独立角色复核了共享派发与用例，确认签名前仍执行身份、回合和观察检查，程序回归覆盖同一 Pending 的保留及接纳。真实 App Server 的异常后续跑仍缺证据，选定探针的回合断言与并发等待也未由该用例覆盖。NAT-14 维持 BLOCKED。

## Windows

Node 22.13.0 与 24.22.2 各通过 8/8，退出码均为 0。双账户固定启动链的常规 `os-stdio isolated` 退出 0，核对四个真实回合、两项拒绝、两份签名、两个 Journal 链和受权审计。三份已部署探针文件与候选字节一致，回环监听清理后为 0。常规样本证据为 P/M/T。

```powershell
$tests='tests/interactive/codex-os-tool-observations.test.mjs','tests/interactive/codex-os-access.test.mjs','tests/interactive/crash.test.mjs'
volta run --node 22.13.0 node --test @tests
node --test @tests
node tests/security/codex-flowkit-probe.mjs <codex> <Model工作目录> <新Host私有目录> os-stdio isolated
node <归档目录>/verify-windows.mjs <checkout> <归档目录>
```

`FlowKit-Windows-G12-Pending-Recovery.zip` SHA-256 为 `d8a1edd64c5bdeb04399e65937eacb9a4ecebad8245711e8ca5a0dfcbc8589d0`。逐项核验 20 个归档文件，包含启动脚本、协议、退出码、部署哈希、定向日志和 Diff。

本机已登记 WSL 2 的 Ubuntu 24.04。对该发行版执行 `wsl.exe -d Ubuntu-24.04 -- /bin/sh -c "id -u; uname -sr; command -v codex; command -v bwrap; command -v node"`，20 秒内未获得标准输出、错误输出或正常退出，结束了该次客户端进程。诊断 JSON SHA-256 为 `78383d3c9137552485958660fa87adb13ddf2f3e8316d5f9d4ff3fbdd16a73f9`。WSL 的测试身份和沙箱可用性仍为 BLOCKED。

## Linux

快进到同一代码候选并核对 75 个依赖文件。普通 Host 的定向回归 5/5，退出 0。既有容器的双账户 `os-stdio isolated` 常规复跑退出 0，耗时 22.30 秒。四个真实回合，两份签名、两项拒绝、Journal 和审计核验通过，无遗留进程。定向回归为 P，真实常规样本为 P/M/T。

```sh
git pull --ff-only origin feat/p0a-interactive-20261112
docker --host=unix:///var/run/docker.sock exec --user 41001:41001 --env TMPDIR=/profile-shared-observations-unit-r5 --workdir /opt/flowkit flowkit-linux-20261113 /usr/local/bin/node --test tests/interactive/codex-os-tool-observations.test.mjs tests/interactive/codex-os-access.test.mjs
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-shared-observations-controller.mjs attempt-1
```

`FlowKit-Linux-Shared-Observations-2594511-20261113.zip` SHA-256 为 `f0d1d7f547216080bf3dccaf51ca0ac4b035265b7f43cd970ab2d4265651f029`。Linux 端核对 173 个载荷文件、ZIP 完整性和逐项哈希。 [Linux 命令、协议与归档](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

### 命令沙箱环境

既有双账户容器沿用 E21 的原始记录。以普通 Model 账户启动 `codex sandbox linux -- /usr/bin/true` 退出 1，bubblewrap 无法创建用户命名空间。容器配置未改变。另检查了托管执行器和已登记环境，尚未找到可供双账户验收的备用 Linux 机器。`FlowKit-Linux-Command-Sandbox-Inventory-20261113.zip` SHA-256 为 `704863665460e881543ee4ec488e66841aef5a306877c7ca387aeeae46e94c03`，逐项核验 43 个载荷文件。

托管执行器的 Codex CLI 0.167.0-alpha.4 使用 `/opt/codex/bin/codex sandbox /usr/bin/true`。普通 UID 1000 执行后退出 0，证据为 P，仅覆盖本地命令启动。盘点归档中的退出 101 来自该版本把旧语法的 `linux` 当作可执行文件。更正记录和原始日志见 `FlowKit-Linux-Sandbox-CLI-Help-20261113.zip`，SHA-256 为 `07ec2550c97ab3390054ad2c169a7ccd8df587146a8eafb473c60483aa819e39`。托管执行器尚未确认为首发隔离双账户目标，SEC-17 维持 BLOCKED。 [Linux 原始记录与更正](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)
