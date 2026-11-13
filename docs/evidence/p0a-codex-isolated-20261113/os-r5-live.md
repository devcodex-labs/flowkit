# R5 OS 操作员与审计角色验收

本批按已确认的首发方案取证。基线 `154fe33981a7f9b7cd7436ccc1339cb5d4437c21`，实测候选 `2f6a6738c5ffc12459bb271823d2468c3b2731cf`。候选增加 Host 参考授权模块并扩展原有 Codex 验收探针。

## 身份与权限

受信启动方分别用两名操作员和一名审计员的普通 OS 账户运行身份读取命令，核对 Windows SID 或 Linux UID 后提供 Host 私有映射。操作员 A、B 分别绑定 `tenant-a`、`tenant-b`，审计员只拥有 `tenant-a` 的 `result:read`。Model 账户独立运行。工具回调只提供业务参数，Host 从受信启动配置和实际 App Server 线程取得授权。映射器签发进程内授权对象，按引用校验授权来源，再校验租户与操作。SDK、Core、ABI 和 Store schema 沿用 R5。

| 角色 | 本轮授权 |
|---|---|
| 操作员 | 所属租户的 `run:create`、`task:dispatch`、`run:complete` |
| 审计员 | 授权租户的 `result:read`，结果只保留在 Host 侧 |

```text
FLOWKIT_OS_ACCESS_FIXTURE=<Host私有映射的绝对路径>
node tests/security/codex-outbox-live.mjs <Codex> <Model工作目录> <全新Host私有根> isolated os-r5
```

## Windows 实测

`os-20261113164512` 退出码 0，回环监听已停止。三次普通账户进程通过 `whoami.exe /user /fo csv /nh` 核验各自 SID。SID、账户、命令及退出码保留在 `windows-os-identities.json`。两个真实 App Server 共完成 9 个模型回合。

| 路径 | 模型回合 | 合法接纳 | 拒绝 |
|---|---:|---:|---:|
| stdio | 4 | 2 | 2 |
| 文件引用 | 5 | 2 | 3 |

每条路径的两个合法回调都到达 Host 后才开始签收。两个租户在同一 R5 SQLite 文件使用相同 `RunId` 与 `startKey`，各自在 revision 4 接纳，revision 9 终态。文件路径的两个独立 256 KiB 快照均成为 `acked`。两条路径都先在 Pending 存在时执行错租户和错主体负例。文件路径再补一例跨租户使用真实历史引用。各负例均返回统一拒绝，签名和 CAS 次数增量为零，Checkpoint、Journal、回执索引和快照索引保持原值。

每条路径在 Host 侧均验证操作员读取完整结果被拒、审计员读取 `tenant-a` 成功、同一审计员读取 `tenant-b` 被拒。日志记录身份、操作、租户、Run、revision 和裁决。独立复核通过四份 Ed25519 签名和四条 Journal 链。

Windows 归档 `FlowKit-Windows-OS-R5-Evidence-20261113.zip` 的 SHA-256 为 `001734197b40dbc51bb0b87b48e4e845cdaf96a656ffefaeb358d8806cd6285d`。24 份文件已逐项复核，含部署及 OS 登录脚本、原始协议、Host 观察、签名和独立复核脚本。已核对三份部署文件和私有映射 ACL。Host、SQLite Store、文件交接和 Outbox 定向回归 37/37。

## Linux 实测

FlowKit 快进拉取同一候选，在隔离容器以普通 UID `41003`、`41004`、`41005` 分别运行身份采集，供受保护配置使用。Host 与 Model 继续使用 UID `41001`、`41002`。正式运行一次，约 52 秒，退出码 0。两个 App Server、六个线程、九个模型回合、十一次工具回调。两条路径分别通过合法回调并发、五次合计拒绝和六次审计判定。独立复核了四份签名、四条共 40 行 Journal 链和两个已签收快照的字节摘要。

```sh
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-os-r5-controller.mjs attempt-1
```

Linux 归档 `FlowKit-Linux-OS-R5-20261113.zip` 的 SHA-256 为 `536163eed158539333af38bfcbc39aa8b5ad49b282ccae55265dea7e205ceddd`，已核对 287 份文件和 ZIP 完整性。归档由 [FlowKit 任务](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable) 保管，包含实际命令、签名、公钥、协议、SQL 快照和离线复核脚本。 [候选 CI 8/8](https://github.com/devcodex-labs/flowkit/actions/runs/43395694815)

## 仍待验收

本批证据为 P／M／T。测试由受信启动方预绑定真实 OS 身份，模型回合由单独 Model 账户运行。审计 API 在 Host 进程内按已核验的审计身份调用。首发实际入口接入经 OS 认证的操作员和审计会话、会话失效和实际权限撤销仍为 BLOCKED。文件入口在 Pending 下用匹配目标请求和合成引用验证拒绝，随后另测真实已接纳引用。仍待补实际入口的未消费有效引用跨租户负例。
