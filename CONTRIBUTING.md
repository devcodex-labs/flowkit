# 参与贡献

FlowKit 为私有专有项目，仅允许经过授权的协作者提交问题、文档改进和实现修复。完整流程见[中文贡献文档](https://devcodex-labs.github.io/flowkit/community/contributing.html)。

SDK 使用 Node >=22.13.0；同时开发文档站使用 Node >=24。在仓库根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix website ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run docs:check
npm run docs:examples
npm run docs:build
```

使用 `npm run docs:dev` 编辑站点。示例主源位于 `examples/docs/`；修改后运行 `npm run docs:sync` 同步 README，再验证消费者。页面使用完整可执行文件、准确输出、错误恢复和相关链接；不要复制私有模块或提交临时日志。

PR 说明具体问题、修复后行为、实际验证及未验证范围。对外公开接口或能力变化先讨论契约和必要性。生成产物使用 `npm run build` 与 `npm run update:goldens` 更新，不手改 header。发布由维护者按[发布说明](https://devcodex-labs.github.io/flowkit/maintainers/releasing.html)执行。

问题报告请附 Node/npm/系统、FlowKit 版本、最小 workflow/host/Skill、配置、命令与退出码、期望和实际结果。删除密钥、用户数据和不必要业务内容。项目使用 [专有授权协议](LICENSE)，访问私有仓库不自动取得再分发权利。
