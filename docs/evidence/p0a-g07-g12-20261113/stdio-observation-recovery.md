# 受控 stdio 工具观察回归

起始提交为 `88fd1324716f819a5f02feb2926f45c1bc3995e1`，代码候选为 `d6bd8d839fe33d344748ee5d889f4bd901cb958f`。`code-increment.diff` SHA-256 为 `464dda730193a38e1bb4700c3365db92f5afa6192201d31e7d17c6261af9e45f`。Requirements V0.3、Technical Design V0.6-R5、P0-A V0.1 和三份附属材料的字节数与 SHA-256 均与 [G01 冻结登记](../p0a-g01-20261112/verified-inputs.txt) 一致。本批修改限于验收探针和回归测试。

## 探针行为与复审

Host 按已绑定的线程和回合记录首个可信工具开始事件。回调缺对应观察、字段或规范化参数失配，或同一回调已处理时，探针先返回统一的 `REQUEST_DENIED`。回调先到时，该回调 ID 不会因迟到事件重新取得资格。拒绝在资源查找、签名和 Store 写入之前返回。定向单测检查缺观察、迟到、失配、重复和下一回合的有效观察。

独立复审发现，同一批 stdio 数据中的回合启动响应和后续事件可能在 Promise 继续执行前一起被处理。代码候选已在处理匹配的 `turn/start` 响应时同步绑定回合 ID，并要求完成事件匹配同一线程及回合。复审确认现有请求响应路径保持行为。当前按已绑定的回合接收观察，若 App Server 在启动响应前发出工具开始事件，探针会拒绝相应回调。该顺序是否实际出现仍待验证。

## Windows

真实固定启动链上的 `os-stdio isolated` 退出码 0。独立离线校验确认四个完成回合，两个合法回执的签名和 Journal 链通过，错主体和错租户各拒绝一次且零新增签名、零 CAS，回环监听清理后为 0。已部署的三个探针文件与代码候选 SHA-256 一致。证据为 P/M/T，覆盖常规入口回归。Node 22.13.0 和 24.22.2 的定向测试各通过 7/7，证据为 P。

```powershell
volta run --node 22.13.0 node --test tests/interactive/codex-os-tool-observations.test.mjs tests/interactive/codex-os-access.test.mjs tests/interactive/crash.test.mjs
node --test tests/interactive/codex-os-tool-observations.test.mjs tests/interactive/codex-os-access.test.mjs tests/interactive/crash.test.mjs
# windows-run-os.ps1 以普通 Host 身份启动
node tests/security/codex-flowkit-probe.mjs <codex> <Model工作目录> <新Host私有目录> os-stdio isolated
node <归档目录>/verify-windows.mjs <checkout> <归档目录>
```

`FlowKit-Windows-G12-Stdio-Observations.zip` SHA-256 为 `2759dfa75753e0f1bccbd1516275e9481c18e6533131c8429a69964fbc556011`。已核对 19 个归档文件，包含原始 stdio 协议、真实启动脚本、部署文件哈希、退出状态、复核日志和增量 Diff。

## Linux

快进到同一代码候选后，既有隔离容器的 `os-stdio isolated` 首次退出 0，耗时 18.10 秒。真实 App Server 完成三个线程、四个回合，核对两份签名、两项拒绝、Journal 和审计，Host／Model 回收后无遗留进程。定向回归 4/4 通过。原生常规回归为 P/M/T，定向回归为 P。`20a621ba2ecff3ba574804933571027ac13c0321` 的首次正向运行保留为中间记录。

```sh
git pull --ff-only origin feat/p0a-interactive-20261112
docker --host=unix:///var/run/docker.sock exec --user 41001:41001 --workdir /opt/flowkit flowkit-linux-20261113 /usr/local/bin/node --test tests/interactive/codex-os-tool-observations.test.mjs tests/interactive/codex-os-access.test.mjs
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-nat14-final-controller.mjs attempt-1
```

实际 Model 进程 UID/GID 为 41002，capabilities 为零，`no_new_privs=1`。普通 Model 账户的 `codex sandbox linux -- /usr/bin/true` 退出 1，bubblewrap 报无法创建用户命名空间。对实际 Model 进程的只读描述符类型观察未能取得类型，记录 `EACCES` 和进程退出期间的 `ENOENT`。命令沙箱和完整描述符范围维持 BLOCKED，容器权限配置保持原值。

`FlowKit-Linux-NAT14-Final-d6bd8d8-20261113.zip` SHA-256 为 `6948f3bf5314bc274cb1d04aa9a45e7ed030222a6c4146a3a90241e544f8817b`。Linux 证据归档包含命令、退出码、原始协议、SHA-256、权限观察及回收核验。 [Linux 原始记录和归档](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

## 裁决

**NAT-14 与 G12 维持 BLOCKED。** 本批验证探针的拒绝逻辑和正常原生回合。完整 NAT-14 仍缺所选 stdio 入口异常顺序下的有界结束和同一 Pending 后续接纳证据。当前回合在立即拒绝后仍会因缺少预期工具调用而无法通过用例断言。Linux 的实际 Codex 命令沙箱和描述符证据另行裁决。供应商故障以及其他 P0 缺口继续见 [发布矩阵](./release-matrix.md)。
