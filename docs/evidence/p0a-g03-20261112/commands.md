# G03 执行与复现

每次真实执行的绝对命令、参数、工作目录、PID、退出码、时间以各 `run-*/observer.ndjson` 的 spawn/exit 行为准。CLI 原始 stdout/stderr 文件按 01 版本、02 项目注册、03 发现、04 doctor、05 实际模型回合编号。MCP 自身的参数摘要和响应记录另见 `mcp-rpc.ndjson`。最初两次错误和首次成功使用迭代中的脚本；它们的实际命令与原始输出均保留。下列调用使用包中当前脚本，覆盖四组边界和 14:41:49 的小参数复测。

```powershell
$g = Resolve-Path outputs/flowkit-p0a-review/G03
$p = Resolve-Path work/g03-cli
$grok = Join-Path $env:USERPROFILE '.grok/bin/grok.exe'
$node = (Get-Command node).Source
Get-FileHash -LiteralPath $grok -Algorithm SHA256
node (Join-Path $g 'run.mjs') $grok $p $node trusted 65536
node (Join-Path $g 'run.mjs') $grok $p $node trusted 262144
node (Join-Path $g 'run.mjs') $grok $p $node trusted 2093056
node (Join-Path $g 'run.mjs') $grok $p $node withhold 0
node (Join-Path $g 'run.mjs') $grok $p $node trusted 0
```

复跑时创建自己控制的空临时项目目录（`$p`），并使用已可用的 Grok Build。脚本对该项目目录使用 CLI 的项目 MCP 注册和信任；不要指向真实项目。生成的三个固定大小样本另存于 `fixtures/`。小内联样本 82 B 是 `JSON.stringify({nonce,payload})` 的 UTF-8；观察器和 MCP 各自计算，不作为 JCS 互操作证明。

错 nonce 的非原生负例（只用本地合成 MCP）：

```powershell
$n = Join-Path $g 'negative-wrong-nonce'
Get-Content (Join-Path $n 'input.ndjson') | node (Join-Path $g 'probe.mjs') (Join-Path $n 'mcp-rpc.ndjson') (Join-Path $n 'absent.gate') expected-fixture
```
