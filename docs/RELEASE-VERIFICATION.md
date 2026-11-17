# v0.1.0 发布验证

本次发布验证日期：2026-11-17。验证在独立公开源码目录执行，不是在用户书稿上试运行。

- `npm run check`：通过。
- `node --test --test-reporter=dot tests/*.test.js`：361/361 通过。
- 五份安装运行时契约均通过：runtime、desktop-transport、selection、optimization、inline-polish；它们没有包含在 `npm test` 内。
- 九个生产 JavaScript 模块与本次发布所依据的功能基线逐字节一致；发布整理仅涉及公开说明、分发元信息和排除内部记录。
- Client SHA-256：`bf6776dfdfdb0fb4b5ce79b8c8e56b6b239e85894aee89855be5597acbe49376`。

这些结果覆盖源码、实际领域/确认回调、隔离存储和安装运行时契约，不证明真实 GUI 的自动换行、焦点、滚动像素、键盘/IME 或视觉效果，也不证明所有模型供应商的实际可用性和费用。

测试要求与完整边界见 [TESTING](<TESTING.md>)。内部装机记录、用户作品元信息、会话标识和模型偏好未随仓库发布；原有本地安装不因建立此公开仓库而切换或重置。
