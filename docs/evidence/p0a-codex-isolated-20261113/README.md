# Codex App Server 双账户验收

适用范围是 Draft #22 的隔离验收。Host 与 Model 各用普通系统账户，Host 持有 FlowKit 私有目录、Store 和签名能力，Model 持有自己的 Codex 登录。探针使用合成任务和字节样本。以下布置用于指定的隔离测试机或 VM，系统账户、SSH 配置和 Codex 登录由该机器的操作者管理。

## 共同布置

1. 将 Draft #22 拉到测试机，记录 `git rev-parse HEAD`、OS、Node 和 `codex --version`。管理员保护 Node、Codex、启动器和探针源码，Model 无写权限。以 Host 账户运行探针，Host 的临时目录和输出目录仅 Host 可写、可读。Model 的工作目录和 Codex 登录目录仅 Model 可写，登录目录也仅 Model 可读。
2. 在测试机上用专用 Model 账户完成 `codex login --device-auth`，再运行 `codex login status`。使用该账户自己的配置目录。保存登录状态与版本，设备码和登录缓存留在登录流程内。Host 无需登录 Codex。[Codex CLI 登录文档](https://learn.chatgpt.com/docs/auth?surface=cli)
3. 若用 SSH，使用仅监听回环地址的测试实例，预先核验服务端主机公钥。Host 专用密钥仅 Host 可读。服务器把该密钥绑定到 Model 账户与固定命令，禁用代理转发、端口转发、PTY 和用户启动脚本。客户端配置 `Host flowkit-model`、Model 的 `User`、`Port`、专用 `IdentityFile` 和 Host 私有的 `UserKnownHostsFile`。记录有效配置的无敏感信息摘要。关闭调试登录输出，以免污染 JSONL。

## Windows

在指定 Windows 测试机上准备两个普通本地账户。编译受信启动器，在账户可读、仅管理员可修改的目录放置结果。

```powershell
Add-Type -Path .\tests\security\codex-model-stdio-windows.cs `
  -OutputType ConsoleApplication -OutputAssembly C:\FlowKitLab\codex-model-stdio.exe
```

SSH 固定命令使用此启动器，唯一参数为 Model 可运行的绝对 `codex.exe` 路径。Model 启动器从实际 Codex 进程令牌读取 SID 并拒绝提升及受 UAC 过滤的管理员令牌，使用 Windows 句柄列表限定继承的三个标准流。Host 在本地通过同一程序的 `--host-identity` 核对自己的 SID。[Windows 句柄继承文档](https://learn.microsoft.com/windows/win32/procthread/creating-processes)

在 Host 的 PowerShell 设置 `FLOWKIT_CODEX_WINDOWS_IDENTITY` 为该启动器的绝对路径，`FLOWKIT_HOST_SID` 和 `FLOWKIT_MODEL_SID` 为实际账户 SID。SSH 模式下将 `FLOWKIT_CODEX_LAUNCHER` 设为绝对 `ssh.exe` 路径，将 `FLOWKIT_CODEX_SSH_CONFIG` 设为 Host 专用配置的绝对路径。

## Linux

使用两个不同非零 UID 和 GID 的账户。使用 glibc 2.34+、Linux 5.9+ 的测试机，编译并部署非特权的 exec shim。

```sh
cc -O2 -Wall -Wextra -Werror tests/security/codex-model-exec-linux.c -o /path/to/flowkit-model-exec
```

当前探针支持预先配置的本机受信启动器，也支持回环 SSH。SSH 的固定命令以 Model 身份执行 `setpriv --no-new-privs`，再用绝对 Node 路径执行 `tests/security/codex-model-identity.mjs`。参数依次为 Model UID、GID、exec shim、Codex 绝对路径及 `app-server --listen stdio:// -c 'web_search="disabled"'`。Model 账户应无额外组成员关系，命令只使用 Model 的 HOME、私有临时目录和受控 PATH。身份 helper 核对有效 UID/GID、组、能力和 `NoNewPrivs`，同 PID 交接给 shim。shim 关闭标准流外的描述符、恢复阻塞标准流，再同 PID 执行 Codex。固定命令及 Model 的 shell 启动环境由测试机操作者保护。

在 Host 进程设置 `FLOWKIT_HOST_UID`、`FLOWKIT_HOST_GID`、`FLOWKIT_MODEL_UID`、`FLOWKIT_MODEL_GID`。SSH 模式同时设置 `FLOWKIT_CODEX_LAUNCHER=/usr/bin/ssh` 和 `FLOWKIT_CODEX_SSH_CONFIG`。本机受信启动器模式设置 `FLOWKIT_CODEX_LAUNCHER` 和 `FLOWKIT_CODEX_LINUX_EXEC`，探针会传入 Node、身份 helper、Model UID/GID、exec shim、Codex 和固定 App Server 参数。操作者为启动器设置有界退出和 Model 侧清理。Host 只关闭标准输入，不能凭自身权限可靠终止其他 UID 的进程。

## 实际验收与留档

在 Host 下分别运行 `node tests/security/codex-flowkit-probe.mjs <绝对Codex路径> <Model工作目录绝对路径> <新证据目录绝对路径> <样本> isolated`。样本为 `loop`、`file-262144` 和 `file-2093056`，每个样本使用不同输出目录。SSH 模式由固定命令决定 Codex 路径，应与记录中的版本和路径一致。对命令、退出码、三个协议原始日志、`observer.ndjson` 和增量 Diff 保存 SHA-256。预期证据包含实际 Host/Model 身份、Model PID、原生开始与回调、同一个 Pending、签收 revision 和最终 `succeeded`。文件样本另核对固定字节数与摘要。

Windows CI 在一次性普通 Model 账户内验证启动器的标准流往返与实际进程 SID。Linux CI 以一次性 Model UID/GID 验证受限身份、同 PID exec 和标准流往返。两者均为 P 级 OS/启动器证据。真实 Windows/Linux 双账户、独立登录和模型签收仍需测试机运行记录。缺少原始记录的项目保持 BLOCKED。

Linux 云任务在基线 `9584184d7098a402a15f3edd8bfb11ea95f7ed49` 拉取后，用专用容器实测 UID/GID 41001/41002。47 项 OS 权限负例通过。用容器内启动器和 stdio 修复，真实 App Server 完成了同 PID 初始化。三个样本均在真实回合返回 401，工具调用、文件登记、签名和接纳均为零。Linux 报告归档 SHA-256 为 `136db4c02521fafaf76d8486d3cfd8cb597f81b39e0d0eceaecac9e61c5c0360`。
