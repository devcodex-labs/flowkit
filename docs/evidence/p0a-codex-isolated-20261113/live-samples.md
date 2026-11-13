# Codex App Server 双账户三样本实测

2026-11-13 在 Draft #22 的 `d9dcc0067b5d24e8a91bbe459256e99d9f285428` 上运行 `tests/security/codex-flowkit-probe.mjs` 的 `isolated` 模式。用户在两个平台各自的 Model 系统账户下完成 Codex 设备登录，Host 账户只运行 FlowKit 探针。

| 平台 | 实测环境 | 普通闭环 | 256 KiB 文件回退 | 近 2 MiB 文件回退 |
|---|---|---|---|---|
| Windows | 普通 Host 和 Model 的实际 SID 不同，受信启动器通过本机回环 SSH 启动 Codex CLI 0.145.0，模型 `gpt-5.6-sol` | PASS | PASS，262,144 B | PASS，2,093,056 B |
| Linux | 专用容器内 Host 41001、Model 41002，Model 零能力且 `NoNewPrivs=1`，Codex CLI 0.167.0-alpha.4，模型 `gpt-6.1-sol` | PASS | PASS，262,144 B | PASS，2,093,056 B |

六次实测各记录三组原生动态工具开始和回调，thread、turn 和 call ID 对应。Host 对真实 Pending 签收，接纳 revision 为 4，终态为 `succeeded`（revision 9，Journal 10 条）。两个文件样本的正文来自受信合成生产者。真实模型读取 PublicTask 后提交 Host 固定的文件引用，两端登记和接纳的字节数与摘要一致。

| 字节数 | 两端 SHA-256 |
|---|---|
| 262,144 | `a89ec2764412be3284c3b2334a8ba4a484bfb7f6df2a8e274acc782a4e3231bb` |
| 2,093,056 | `716f7d91c27f9e89e87fa13d2e2d47ba3b4dba942cb42f371610eac0ed83fd87` |

Linux 登录后的首轮因缺少配套 Code Mode 组件，模型完成回合但没有提交工具调用。FlowKit 任务从同一 Codex 安装补齐 `codex-code-mode-host`、`codex-exec-server` 和 `bwrap` 后重跑通过，首轮原始记录留档。Linux 测试容器仍需为长期运行配置 init/reaper。本轮 Windows 回环 SSH 使用签名校验通过的便携版，监听 `127.0.0.1:41762`。系统 OpenSSH 服务保持停止，默认入站规则已禁用。

P、M、T 级证据覆盖这三个样本的实际程序运行、真实模型回合和独立系统身份下的原生工具通道。完整 256 KiB 和近 2 MiB 的内联传输、双会话竞争、签后强杀与自动 Outbox 恢复、完整 NAT-14/15 与 C12/S13 仍为 BLOCKED。验收记录保存 Host 验签接纳及声明摘要，离线独立重验原始签名仍待取证。

| 原始证据包 | ZIP SHA-256 |
|---|---|
| Windows 本次验收交付 `flowkit-windows-dual-account-evidence.zip` | `5442cd27e74674451a1f16ea88c24f84f01ca7a74fab7f6d0fd8fc036dca4d76` |
| Linux FlowKit 云任务交付 `FlowKit-Linux-Live-Three-Samples-20261113.zip` | `b18af80ac30c49694bdff4b4d1aeb4c0c5e835bcd849a09152b057af4474cb50` |

两个归档包含实际执行记录、原始协议日志、Host 观察日志和逐文件哈希。设备码、密码和令牌留在登录边界内。
