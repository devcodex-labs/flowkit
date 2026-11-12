# G05–G06 双账户 Host 隔离

本批验证 Windows 和 Linux 上的两个独立非管理员主体。测试使用一次性目录、测试签名密钥、真实 FlowKit SQLite Store 和可公开的任务样本。启动器把 Host 和受限测试进程作为不同身份启动。每个进程报告实际 SID 或 UID、PID 和父 PID。Windows 同时记录文件与目录的实际 SDDL，Linux 记录权限位和有效能力。启动器以白名单构造环境，测试进程验证 Host 的环境标记未传入。

这是一套可复跑的隔离测试配置。已有的 Linux M5/M6 隔离测试仍在 CI 中运行。新增测试不需要服务、监听端点、模型账户或外部凭据。真实模型接入的启动及句柄继承验收仍属于后续部署测试。

## 运行方法

从仓库根目录运行，使用 Node 24.22.1。

```sh
sudo -n "$(command -v node)" tests/security/secure-host-linux.mjs
```

Linux 启动器要求一次性环境，且 UID/GID 41001 和 41002 未占用。只有引导进程使用 root。两个实际工作进程通过 `setpriv` 清空附加组及能力，并启用 `no_new_privs`。Host 私有目录为 0700，密钥为 0600。

```powershell
.\tests\security\secure-host-windows.ps1 -Node (Get-Command node.exe).Source -DisposableRunner
```

Windows 使用一次性 Windows Server 2025 运行机、提升权限的 64 位 Windows PowerShell 和两个随机命名的本地普通用户。引导进程创建显式 DACL，只有 Host 能修改私有目录，SYSTEM 和 Administrators 保留恢复权限。测试用临时账户和目录在结束时清理。

## 验收映射

| 范围 | Linux | Windows |
|---|---|---|
| SEC-01 进程身份 | 核对 Host 和受限进程的实际 UID/GID、进程身份、能力和附加组。 | 核对两个进程的实际 SID、Administrators 组及调试等高权限。 |
| SEC-02 密钥、配置和产物清单 | 测试各文件的读取、复制、打开写权限、删除、移走和替换。验证 Host 签名仍可用。 | 同样的文件测试及实际文件/目录 DACL。 |
| SEC-03 SQLite、WAL、SHM 和备份 | 数据库打开期间验证六类访问被拒。Host 关闭后重新打开主库和备份做完整性检查，并核对受保护文件的字节摘要。 | 同样的文件和完整性测试。 |
| SEC-04 进程访问 | 验证 Host 进程 fd、环境和内存入口的读取被拒，并检查无副作用的信号权限探测。 | 验证内存、线程创建和句柄复制权限请求被拒，验证不可获取可复制或可分配的 Host Token。只请求并关闭测试句柄。 |
| 句柄范围 | 实际枚举受限进程的 `/proc/self/fd`，校验没有 Host 私有文件，原生启动链仍待验证。 | 当前启动器分别启动两个账户，不向受限进程提供 Host 私有句柄。系统级子进程句柄表仍待在最终启动方式下验证。 |
| SEC-17 Linux 实际受限进程 | 验证跨 UID 的脚本进程和 OS 拒绝。原生模型进程与可信来源仍待 G07 以后验证。 | 不适用 Linux UID 条款。 |

Linux 的 47 次、Windows 的 43 次文件和 Linux 进程拒绝由测试计数校验。Windows 另有 6 次进程或 Token 权限请求。两边都有公开任务可读的正例。Windows 测试没有部署 Windows Service，服务控制权限要在采用该部署方式时单独验证。

以当前 GitHub CI 的 `Verify the disposable Linux Host profile` 和 `Verify the disposable Windows Host profile` 实测输出为准。只做语法检查时，不能把对应平台记为通过。G05–G06 证据用于 OS 隔离，原生 N 级、NAT-14 和 G07 保留现有阻断。
