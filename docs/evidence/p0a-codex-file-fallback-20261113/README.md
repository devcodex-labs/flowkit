# Codex 文件回退验收

Draft [#22](https://github.com/devcodex-labs/flowkit/pull/22) 的基线 `eb5823094cdee0f5d8fe8a558a9824e1c712db4d` 在 [CI](https://github.com/devcodex-labs/flowkit/actions/runs/43343789989) 8/8 通过。本批只修改 Host 示例、Codex 探针和测试。FlowKit Core、Receipt V1、Checkpoint 格式、内联容量和包导出沿用原契约。

Host 在预设入口用受信来源登记字节数、SHA-256、Pending 和会话。工具收到的是 Host 颁发的随机引用和 requestId。入口文件只打开一次并有界读取，读取时检查普通文件、身份、长度和变化，随后校验实际原始字节的摘要、严格 UTF-8、规范 JSON 和应用提供的 schema。原始字节以 BLOB 写入 Host 私有 SQLite，使用 WAL/FULL。入口文件此后可删掉。模型工具不接收文件路径，也没有登记摘要和读取私有 BLOB 的能力。

提交时，Host 比较自己观察到的动态工具开始事件和回调，核对 thread/turn/call、相同规范参数、当前 namespace/Run/Request/Node/Attempt、Program/Policy 摘要和时效。再次校验私有快照字节数和 SHA-256，原子领取一次，然后才调用可信签名与接纳。已签收的 Agent 结果只包含快照 ID、长度和 Host 摘要。调用结束时记录接纳 revision。失去签收结果的已领取引用保持锁定，等待人工对账，重开后也不会重签。过期且未领取的快照可清除。已领取及已接纳快照的持久恢复和保留由部署方决定，自动 Outbox 恢复仍属独立验收。

| 样本 | Codex App Server 同账户实测 |
|---|---|
| 256 KiB（262,144 B） | Codex 读取真实 Pending，提交有界引用。Host 从已保存原始字节核对摘要，签名并接纳，再返回 succeeded。 |
| 近 2 MiB（2,093,056 B） | 同路径，快照字节数和摘要与登记一致，仍只把引用写进 FlowKit State。 |

两个样本由受信合成生产者生成。模型实际调用了 App Server 的动态工具并提交引用。Host 在签收前删除入口文件。日志分别记录原生开始事件、回调、快照 SHA-256、签名、接纳和终态。Windows/Linux 双账户原生宿主、生产文件入口的权限部署、真实签后崩溃恢复及 NAT-14/15 仍 BLOCKED。此次文件回退实测的对象是 Host 合成输入和模型提交的真实引用。

定向用例覆盖入口文件在登记前被替换、截断、超限、非法 UTF-8/重复键/schema、错误 Pending 或会话、缺少开始事件、重复或并发消费、过期、已领取后重开。登记成功后替换或删除入口文件，签收使用已固定的原始快照。

## Windows Node 22 文件身份回归

基线 `7acdfdd0137bc34cd4407ee9ffb8c2fa1e5a18a7` 的 [Windows Node 22.13.0 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43345740815/job/131624564355) 将普通入口文件误判为 `FK_FILE_SOURCE`。在 Windows 实测，Node 22.13.0 对同一文件的 `lstat` 返回设备号 0，句柄 `stat` 返回非零设备号，两者的文件 ID 一致。Windows 路径查询缺失设备号时仍要求打开前后路径与句柄的非零文件 ID 一致，并要求两次路径查询的设备号相同。可用的非零设备号仍须匹配。校验同时保留普通文件、单链接、长度、时间戳和原始字节 SHA-256 检查。

P 级回归用真实文件和私有 SQLite 测试。新增硬链接和文件符号链接拒绝用例，Windows 无文件符号链接权限时实测目录联接点。两项拒绝后，同一请求仍能登记合法文件。Windows/Linux 双账户 Codex App Server 仍 BLOCKED。
