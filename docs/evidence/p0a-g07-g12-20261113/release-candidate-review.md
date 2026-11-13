# P0-A 首发候选联合验收

基线为 `cb55668e8b22a9753823399f54d7c58d050508ef`，代码候选为 `c338cd46261757e598ae63b2738c9f9d03f08be8`。代码增量 diff SHA-256 为 `7508c81c6d43acee1e09493e6fb46cb16f4a01ea2bcb03aef2c8cb7f91e2cb0d`。复核了 Requirements V0.3、Technical Design V0.6-R5、P0-A Plan V0.1 原件的字节数和 SHA-256，均符合 [G01 登记](../p0a-g01-20261112/verified-inputs.txt)。使用已确认的 Codex App Server 参考宿主范围。 [代码候选 CI 8/8](https://github.com/devcodex-labs/flowkit/actions/runs/43423047730)

## 本批通过的项目

- **原生正向链。** E1/E10 的 Windows／Linux 普通双账户样本证明真实 JS、Model 工具调用与 JS 状态推进，含同一 Run 的四次 Agent 接纳。E2–E4/E8 证明双会话竞争、签名与 CAS 边界恢复。E11 已核对模型开始事件、回调及迟到、失配、超时的无写入行为。E18 证明回合中本地传输骤断与按 Run 扫描恢复。以上实测沿用各自记录的提交及环境，当前批次以程序回归和独立证据复核覆盖改动。
- **R5 提案契约。** Coordinator 对生成提案先做纯数据快照，再按提案种类限制必需与允许字段，检查栈和合并形状。候选提交和重试分别绑定既有 `commit`、`prepare` 阶段，Agent 入栈初值绑定认证事件。包导出、生成 Program ABI、Store schema 和 Standard 入口沿用现有契约。
- **T29 Genesis 前后。** Windows Node 22.13.0 与 24.22.2 的定向回归各 51/51。F01 在 Program 注册后、Genesis 写入前强停，SQLite 中无 Run、Journal 或 Run 的 Program 引用。同 startKey 随后只创建一个 Run。F02 在 Genesis 事务提交后强停，保留 revision 0、单条 Journal 和 Program 引用，同 startKey 复用 Run 与 Pending。已有程序测试另覆盖准备、发布、接纳、验证、提交、路由前后 12 个切点。此项为 P 级。

```powershell
$files = @('tests/interactive/coordinator.test.mjs','tests/interactive/crash.test.mjs','tests/interactive/p0a-ops.test.mjs','tests/interactive/p0a-staging-backup.test.mjs','tests/interactive/p0a-staging-ops.test.mjs','tests/interactive/complex-c01-c12.test.mjs')
volta run --node 22.13.0 node --test @files
node --test @files
```

Linux 先快进拉取 `cb55668e8b22a9753823399f54d7c58d050508ef`，既有专用环境的故障、并发和备份回归 8/8。随后快进至 `c338cd46261757e598ae63b2738c9f9d03f08be8`，使用普通 UID 1000 和 Node 24.22.1，新增回归 3/3、切点和并发回归 3/3。新增候选验证为 P 级程序回归。`FlowKit-Linux-Unified-Defensive-20261113.zip` SHA-256 为 `fee340a675f7f3d31f36305c40f8ca45d498bc5e943179688aa55ad82b0ceabf`，Linux 端核对归档完整性和 212 个载荷文件的哈希。 [Linux 命令、原始日志与归档](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

```sh
git pull --ff-only origin feat/p0a-interactive-20261112
node --test --test-name-pattern 'Genesis|proposal field' tests/interactive/coordinator.test.mjs tests/interactive/p0a-ops.test.mjs
node --test tests/interactive/crash.test.mjs
```

## G12 独立裁决

**BLOCKED。** 独立角色复核了代码候选、冻结要求和原始证据。提案字段、分阶段目标、Agent 入栈与 Genesis 修正均经复核。发布时实际选择的 Windows／Linux 配置仍须覆盖下列适用 P0。

| 剩余门禁 | 收口条件 |
| --- | --- |
| SEC-02–06、08–09、11、15、17 | 在同一参考启动链完成真实 Model 隔离、启用入口的主体和租户授权、来源拒绝以及最小披露。Linux 需实际受限 Model 进程证据。已有测试进程与原生子样本可复用。 |
| SEC-10／T29、S02，T28／T30 | 核对实际选定宿主的组合恢复断言与完整符合性，保留 E19 的新增程序切点与提案校验。 |
| C12／S13／T27、NAT-01、06、07、10、11、12、14 | 真实正向闭环已证，完整来源、实际启用入口的授权、会话变更和故障语义仍待验证。真实供应商故障缺独立事件证据。 |

当前参考配置使用受控 stdio，不启用 TLS／mTLS IPC 或 Named Pipe，对应的 SEC-07／16 为 N/A。NAT-13 的供应商可验证签名是能力探测。SEC-12／13／14／19 的 P1 运维项按首发声明和实际部署范围审查，适用的 P0 拒绝、隔离和恢复仍须通过。ChatGPT／Grok 专项和跨 OS 搬移 SQLite 物理库按各自范围登记。

## G17 发布准备

本地 `v1.0.0` 元数据预检、构建、打包和独立验包通过。候选 `devcodex-labs-flowkit-1.0.0.tgz` SHA-256 为 `9101a8c173aa2c3405a3c693dcf2c6e685954f28255c60669eb1af4ac3597934`。在新目录从同一 tarball 用 npm 缓存离线安装成功，Standard／Interactive 入口导入通过，安装后的 63 个文件哈希逐项与清单一致。原始在线文档消费者安装在本机超时并留档。CI 四矩阵各通过 13 个文档消费者场景，Windows 两份报告的 tarball SHA-256 与本地候选一致，Ubuntu 两份均为 `e47d0f2aa2db1fb0e0614e74f3326597baa61e2449651fe08d0fd111018e078d`。正式发布工作流以它构建并验证的包为准。

```powershell
npm run release:check -- --tag v1.0.0
npm run build
npm run release:pack -- --tag v1.0.0
node scripts/release.mjs verify --tag v1.0.0
npm install --offline --ignore-scripts --no-audit --no-fund --save-exact ./devcodex-labs-flowkit-1.0.0.tgz
```

正式 G17 等 G12 放行及明确授权，届时按目标提交重新确认包身份并运行发布工作流和私有包安装验证。
