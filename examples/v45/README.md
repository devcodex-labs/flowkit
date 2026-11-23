# V4.5 软件交付参考工作流

`software-delivery.workflow.js` 声明 140 个节点。Interactive P2 通过受信 Host 执行各节点，SQLite 保存 Program、待办、回执、版本和审核。此目录的 Host 绑定提供一条具体的隔离业务用例，变更内容是让文本标准化处理支持首尾空白。根输入可请求追加迁移演练。该用例的目标、权限与放量阈值由隔离 Host 固定。

在仓库根目录安装锁定依赖后执行：

```text
node examples/v45/verify.mjs
```

只验收成功交付时可指定 `delivered`。如果 npm CLI 不在 Node 安装目录，可把 `FLOWKIT_V45_NPM_CLI` 设为本机 `npm-cli.js` 的实际路径。依赖审计使用已安装工具链及其锁文件，通过 npm 注册表返回可复核的真实结果。仓库根需要 Git、npm 与带 `node:sqlite` 的 Node。

验收在 `.tmp/v45-reference/` 新建 Git 源仓库、分离的工作区和 SQLite 发布目标。工作流执行实际源码变更、单测及覆盖率、集成检查、类型检查、SBOM 和依赖审计。受信 Host 用隔离的需求审核与发布审核主体签收文件版本。SQLite 目标记录预发、切流、放量和独立的回滚写入。包含故障注入的场景保留实际文件、操作账本与终止证据。

同一次运行编译一份 Program，通过交付成功、回滚成功、回滚资格失败、恢复写入失败、归档失败、用户拒绝和需求澄清覆盖全部声明。`verification.json` 提供每个 Run 的终点和节点覆盖，运行目录内的 `trace.json` 提供受权回放、待办恢复、文件版本和 SQLite 目标写入。用户界面和技能在后续批次接入同源 `workflow.graph.json`。
