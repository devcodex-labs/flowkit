# G03 — Grok Build 原生工具能力 PoC

**已执行，结果 PARTIAL；G07 的安全前置条件 BLOCKED。** 真正的 Grok Build 能注册、发现并调用本地 MCP，且小型内联入参有独立可观察的开始事件。文件入参可到 MCP，但开始事件只含文件路径；PoC 未取得在要求范围内可独立验证的完整开始入参，也没有可信签名、持久收据或受保护的观察链。不能据此通过 NAT-14、S13、T27 或宣称原生安全宿主可用。

基线 `21b02e785cacf703c359d7d4f853b8196aa17b19`，无 FlowKit 产品代码改动。Windows，Node `v24.22.2`，真实 `grok 1.0.83 (adcd31156f45)`，Grok EXE SHA-256 `b589678bb2597796068b7d2add337a7182f93ef76522267fa2db28a894f50557`，成功回合的模型为 `grok-4.7-build`。初查 `grok models` 报未认证，随后真实模型回合成功；未提供或读取凭据，也未为其他目录扩大权限。只对临时项目 MCP 目录使用 `--trust`，以 `dontAsk` 和 `MCPTool(flowkitg03__probe)` 运行，未启用无条件审批、shell、web search 或子 agent。

## 真实观察

`run.mjs` 启动真实 CLI，逐字节保存 stdout/stderr；另外解析流里的 `tool_call`/`tool_call_update`。临时 stdio `probe.mjs` 是合成工具，不依赖 FlowKit 或任何签名/Store。观察器只在拿到同一小型内联参数的 SHA-256 和 `toolCallId` 后写临时 gate；MCP 端独立由收到的参数计算摘要、核对 gate，最多等 4 秒。注册命令、MCP Doctor 实际握手和发现、CLI 实际事件在每轮原始日志中保存（详见 `commands.md` 和哈希清单）。

| 样本 / 日志目录时间（UTC） | CLI 开始事件 | MCP 实收 / 响应 | 裁决 |
|---|---|---|---|
| 小内联，14:32:48 与 14:41:49 | `use_tool`，`pending`，`rawInput.tool_input` 为完整 82 B 规范样本；同 ID 后续 `completed` | 两次独立摘要相符，gate 放行 | 真实能力成立；只能证明观察早于工具成功返回 |
| 64 KiB，14:34:56 | 有 ID，仅 `rawInput.tool_input_file` | 65,536 B，与文件 SHA 相符；门保持关闭，调用 failed | 传输到 MCP 成立，开始事件未给字节 |
| 256 KiB，14:35:18 | 同上 | 262,144 B，与文件 SHA 相符；门保持关闭，调用 failed | 同上 |
| 2 MiB − 4 KiB，14:35:44 | 同上 | 2,093,056 B，与文件 SHA 相符；门保持关闭，调用 failed | 同上；仅为选定的近上限样本，非声明 CLI 或 FlowKit 精确上限 |
| 不放行，14:36:14 | 有真实开始、ID/小入参均相符 | 人为扣住 gate；MCP 4,022 ms 后返回失败，随后同调用 ID failed | 该 PoC 有界失败，不会因缺 gate 永久等待 |
| 错 nonce，本地负例 | 无真实 CLI / 无模型 | 独立调用合成 endpoint，`isError:true`、无 gate，未释放 | 只证 fixture 拒绝无匹配；不能证明抵抗伪造 stdout、写 gate、文件替换或跨用户攻击 |

文件传输的三组 fixture 和 MCP 摘要分别是：

- `e582bd96184cfa8782f824471e756f0e1303e114eb0f6d358559f2cb62837a37`
- `30f1255d6ed2eedec663b7cd6ecf4133dcc9f932e9f7be11cfb8049d9ebe9393`
- `b077081ef9635e26d2a1049d3644770e14d822ecbafe1a256c7636c454eaee71`

小内联复测 `run-2026-11-12T14-41-49-005Z`，调用 ID `call-a577f2f9-8591-481e-bc3d-176a4414176c-1`，摘要 `01560b2722fa7cad8483fbd839b54b3f22b6ae2a860f49a4bf6444b2052a17a9`。同机 epoch 毫秒：MCP ingress `1794494524116` → 观察开始 `1794494524122` → gate `1794494524123` → MCP response `1794494524155` → CLI completed `1794494524157`。首次正例也为 MCP ingress 先发生（领先 4 ms）；没有观察到可保证先于工具进程接收请求的 hook。两进程的 wall clock 用于对齐，观察器另记单调时间；这些时间不证明 API 一般性顺序保证。这里没有签名步骤；所谓“签名前”最多能在合成门中模拟，不是签名前安全验收。

两次失败的安装/授权探索也保留：14:30:41 项目工具因目录未信任而拒绝，14:32:29 使用的旧 permission 语法无效。某些 CLI 回合退出码为 0 但工具事件是 failed，因此以工具事件和 MCP 实收为准。文件路径只作定位，不能把读同一路径当作“同一字节”的来源证明。本轮未测大入参直接内联的模型生成/流截断，不能推出 CLI 所有模式均无法观察大参数。

## 证据等级与复审门槛

G03 是真实 CLI PoC。**无新增 FlowKit P/M/T/N/V**：未执行 FlowKit JS 或 Pending，M 要求真实模型处理真实 FlowKit Pending；观察器与模型端使用同一 OS 用户，不能作为受保护 T；没有生产 Host、签名/CAS、端到端 N 或可独立验证的 V。原始流中的不透明 usage 字段不作为 provider 签名证据。

继续 BLOCKED：完整大入参的独立绑定；真实 Host/Pending/tenant 的预签绑定；受保护 OS 通道和伪造负例；NAT-14。供复审的备选：验证是否有能提供同一份规范字节的原生流，或单独裁决一种由受保护 Host 生成并固定不可变内容摘要的传递机制；后者须验证路径替换、独立身份、顺序与失配拒绝，不能信任模型自报摘要。没有实施备选，也未启动 G05/G07/H3-02。文档参照：[Grok Build CLI](https://docs.x.ai/build/cli/reference)；本报告运行事实来自原始记录。
