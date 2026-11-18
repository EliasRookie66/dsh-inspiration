# 测试与验证边界

本仓库包含可运行源码与测试，不包含用户书稿、profile 数据、模型会话日志或内部装机验收记录。

## 可移植测试

在仓库根目录，使用 Node.js >=22：

```sh
npm run check
npm test
```

`npm test` 只执行 `tests/*.test.js`，覆盖领域逻辑、临时存储适配、作者确认守卫、客户端纯函数及浏览器产物注册。它不执行下方八份安装运行时契约，也不调用付费模型或操作用户作品。

修改连续 Markdown 编辑器时，先安装锁定的构建依赖，再验证 CodeMirror 的纯状态、选择及装饰契约。插件安装运行不需要这些依赖：

```sh
npm --prefix editor-build ci --ignore-scripts
npm run build:client
npm run check:client-build
npm test
```

未安装构建依赖时，纯 CodeMirror 测试会显式跳过；其余测试仍需通过，打包产物仍必须和客户端源码同步。

## 安装运行时契约

这些集成脚本要求已安装与清单匹配的 DSH **0.2.2-rc.3**，以及支持同步 `node:module.registerHooks` 的执行器（Node.js >=22.15 或合适的更新运行时）。Desktop 转发契约还依赖已安装 Desktop 的 ASAR 布局及该版本内部实现，不是跨平台浏览器测试。

请由运行 DSH 的环境提供：

- `DSH_INSTALL_DIR`：DSH 安装目录，包含其依赖和所需源码。
- `DSH_NODE_EXECUTABLE`：与该安装匹配的执行器；对于 Electron 安装版，下列命令使用 `ELECTRON_RUN_AS_NODE=1`。

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/runtime-contract.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/desktop-transport-contract.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/selection-runtime-contract.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/optimization-runtime-contract.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/inline-polish-runtime-contract.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/writing-constraints-runtime-contract.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/autosave-runtime-contract.mjs
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/markdown-constraints-runtime-contract.mjs
```

运行时契约使用隔离临时存储、测试适配器或明确的测试认证能力，验证实际安装模块的相应行为；不等于向真实服务商生成、操作真实书稿或验收当前 GUI。

## 没有验证的内容

- 实际浏览器/桌面页面中的像素布局、焦点、滚动位置、键盘/IME与屏幕阅读器行为。
- 所有模型/服务商的网络、额度、费用或输出质量。
- 未声明支持的 DSH 版本、多人/公网部署、其他高权限插件或本机恶意程序的隔离。

原位润色位置恢复含实际确认回调与数值计划回归，但纯数据和源码测试不能证明用户可见滚动效果。请在正常作者审阅中确认，不要仅为测试采纳不想要的修改。
