# R5 授权撤销与未消费文件引用

基线 `e40123fc04ebab1b94b8a558ff88af681d84e98c`，实测候选 `3fd1d2f9fb8a59abf74fca86136cb0bed3eef806`。候选增加接受已认证对端的 Host stdio 参考入口，支持按配置撤权及断流销毁授权。配置移除身份后，同一打开的会话立即失去读取权。恢复映射时，旧会话仍拒绝，须建立新会话。两个平台仍用已有 Host、Model 账户隔离以及操作员和审计身份预绑定。

真实文件样本由 Host 固定 262,144 B 原始字节，并与当前 Pending 和合法 Model 调用绑定。在文件处于 `staged` 时，另一租户提交同一有效引用。Host 统一拒绝，零签名、零 CAS，两个租户的 Run、Journal、接纳索引及文件索引逐项不变。原会话随后使用同一引用，文件进入 `acked`。

撤权样本在 Host 进程内用两条流连接 stdio 入口。审计角色先读成功，移除映射后同一会话被拒，恢复映射后旧会话仍被拒，新授权对象可通过检查。测试检查 Store 状态无写入。OS 启动身份已核验，审计流使用 Host 内 `PassThrough`。最终生产通道如何认证对端、跨 Host 撤权发布以及实际部署仍为 BLOCKED。

本批只读审查发现，已经开始的异步读取可能在撤权后返回结果。后续修复在返回 `result:read` 响应前再校验一次授权。定向回归覆盖撤权时仍在执行的读取、撤权后重授权及超长输入后的下一条命令。该修复的 P 级验证随最终提交 CI；下列真实 Codex 归档仍绑定上方实测候选。

```text
FLOWKIT_OS_ACCESS_FIXTURE=<Host私有映射的绝对路径>
node tests/security/codex-outbox-live.mjs <Codex> <Model工作目录> <全新Host私有根> isolated os-r5
```

## Windows

运行 `os-20261113170741`，退出码 0。两条路径合计 10 个真实模型回合、6 次工具拒绝、4 份合法签名和 4 条完整 Journal 链。受信启动方分别核验三名普通账户的 SID。独立复核匹配了跨租户负例、`staged` 证据与随后合法签名中完全相同的文件 ID。监听已收回。定向回归 37/37。

`FlowKit-Windows-Session-R5-20261113.zip` 的 SHA-256 为 `4f5cda75780541aad5ccc22ddfbad55408fa5894b789f507960258166177f99f`，已复核 22 份文件。归档包含执行脚本、原始 App Server 协议、Host 观察和独立复核脚本。

## Linux

FlowKit 快进拉取同一候选并执行 `os-r5`。首次正式运行约 61 秒，退出码 0。两个真实 App Server、六个线程、十个模型回合、十二次工具回调。独立复核四份签名、四条共 40 行 Journal 链，以及两条撤权流共十二帧原始字节。六次拒绝均符合预期。

```sh
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-os-revocation-r5-controller.mjs attempt-1
```

`FlowKit-Linux-OS-Revocation-R5-20261113.zip` 的 SHA-256 为 `b2bb15926b6ee9f6c203f94e1e1d2de854ed62936864cc967499b6e1c3f6caf4`，已复核 227 份文件和 ZIP 完整性。归档由 [FlowKit 任务](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable) 保管。 [真实样本候选 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43398681714)
