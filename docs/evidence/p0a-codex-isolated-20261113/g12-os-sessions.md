# G12 OS 操作员与审计员会话实测

实测提交 `9ba894ce702d84e20d9a51a57d015e225774b851`，承接 [E12 OS 角色](./os-r5-live.md) 和 [E13 会话撤权](./session-r5-live.md)。本次在专用环境启动普通 Host、操作员 A/B、审计员进程，由受信监督器根据其创建的 OS 进程和预期 SID／UID 建立 Host 会话。操作员和审计员经各自进程管道发送命令，监督器转发至 Host 并收集结果。审计回复由监督器核验，未通过生产审计通道送回审计员进程。生产部署的启动与配置分发仍须按实际环境验证。

两位操作员在各自租户用同一 `RunId` 创建 Run。两份结果均为 `succeeded`、revision 2。操作员读取私有结果及审计员跨租户读取被统一拒绝。审计员可读取获准租户的私有状态。移除操作员 A 与审计员的映射后，已打开的连接拒绝创建与读取。恢复映射后旧连接仍拒绝，前后两库的 Run revision 与 Journal 行数一致，拒绝的新 Run 不存在。重新创建 OS 对端和 Host 会话后，合法创建和读取恢复。此样本使用终态工作流，不涉及模型签名；真实 App Server 文件提交由 E13 验证。

## Windows

`windows-os-session.ps1` 在受保护的测试部署中启动一个普通 Host、两名普通操作员和一名普通审计员，再为恢复后的操作员和审计员各启动一个新进程。独立读取进程 SID 和 PID，与启动方的账户配置匹配。六个进程最终均退出 0。两个早期尝试分别遇到工作目录和测试程序 ACL 拒绝，原始日志均保留。最终将只读对端测试程序放到单独的临时目录，完成后移除该目录。

`FlowKit-Windows-G12-OS-Sessions.zip` 已逐项复核，SHA-256 为 `9bb2481116e12bd18c6f4ca43863b491d1cef743bae51a3366e4d55327616e9f`。包含实际启动脚本、三次原始记录和通过结果。此证据为 P 级实际 OS 进程和 Host 授权。

## Linux

FlowKit 快进拉取同一候选。六个普通子进程的 UID、零有效 capability 和 `NoNewPrivs` 经独立观察核对。撤权前后的完整 SQLite 快照一致，新连接恢复后才新增 Run。首次正式运行通过。

```text
node tests/security/p0a-os-session.mjs linux-supervisor <新Host私有目录> <映射绝对路径>
```

`FlowKit-Linux-OS-Process-Session-20261113.zip` 的 SHA-256 为 `49fe426a9b8f04aee21d0967c6184aabcd918d79898357da82e68ff323087973`，127 份文件已逐项复核。原始启动命令、进程记录、SQL 快照和归档由 [FlowKit 任务](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable) 保管。
