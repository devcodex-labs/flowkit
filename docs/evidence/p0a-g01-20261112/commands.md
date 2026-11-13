# G01 执行与复现

PowerShell；命令从本次工作区运行，日志随本文件分发。审查用 detached worktree 对象为 `21b02e785cacf703c359d7d4f853b8196aa17b19`。

```powershell
git ls-remote https://github.com/devcodex-labs/flowkit.git refs/heads/main refs/heads/feat/p0a-interactive-20261112
git -C D:/Worker/flowkit -c core.longpaths=true worktree add --detach <worktree> 21b02e785cacf703c359d7d4f853b8196aa17b19
Get-ChildItem work/frozen-originals -File | Get-FileHash -Algorithm SHA256
Get-Content -LiteralPath <original-path> -Encoding UTF8
```

进入审查 worktree，实际依次运行 `npm ci` 与 `npm run verify`，各自重定向 stdout/stderr 并记录 `$LASTEXITCODE`。两条命令输出分别见 `npm-ci.*` 和 `npm-verify.*`；探针调用如下：

```powershell
$audit = Resolve-Path outputs/flowkit-p0a-review/G01
$repo = Resolve-Path work/flowkit-pr22
node (Join-Path $audit 'probe-cf08.mjs') $repo 1> (Join-Path $audit 'cf08.stdout') 2> (Join-Path $audit 'cf08.stderr')
$LASTEXITCODE | Set-Content (Join-Path $audit 'cf08.exit')
```

正式原件包身份：`FlowKit-Interactive-Development-Handoff-For-Grok-2026-11-10.zip` = `8a2f679a796234383b5108d58db16c1016a35c6110301bc4eb7e091ee2ed5826`；`FlowKit-Interactive-V0.6-R5-Confirmed-Handoff.zip` = `2deb5b3fa60ed3b7c2d29f028e33835c47aaa0a976e947de717128caf7326549`。计划见 [Library 原始条目](https://chatgpt.com/space/file/libfile_de7a4fcb51c881919e942f9348ccd935)。读取各自原始文件的 SHA-256 和长度见 `verified-inputs.txt`。ZIP 原始条目解压后校验的是条目字节，未保存为重编码版本。
