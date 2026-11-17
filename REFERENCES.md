# 设计参考与许可记录

调研时间：2026-11-13。以下为只读源码/文档研究，**并未运行这些参考插件来证明当前 DSH 兼容性**。灵感没有复制第三方实现代码或资源；下列许可是来源记录，不代表本插件包含它们的源码。

## novel-writer

- 版本 1.0.2；快照 [`bd0082106998a4737d3428bed334cacde46accd9`](https://github.com/sailoumili/novel-writer/tree/bd0082106998a4737d3428bed334cacde46accd9)，[MIT](https://github.com/sailoumili/novel-writer/blob/bd0082106998a4737d3428bed334cacde46accd9/LICENSE)。
- 参考叙事契约、人物/世界观/声音/伏笔/章节索引分层管理，以及文件化版本交接。
- 未采用六角色流水线。它主要是 preset 与提示词纪律，不宜说成已提供安全选区正文编辑器。

## dsh-novel-forge

- 版本 1.7.0；快照 [`7f05dfb8636da65681678fbabb3e9f9a23b442e7`](https://github.com/huangziyuan-general/dsh-novel-forge/tree/7f05dfb8636da65681678fbabb3e9f9a23b442e7)，[MIT](https://github.com/huangziyuan-general/dsh-novel-forge/blob/7f05dfb8636da65681678fbabb3e9f9a23b442e7/LICENSE)。
- 借鉴 [上下文包与预算报告](https://github.com/huangziyuan-general/dsh-novel-forge/blob/7f05dfb8636da65681678fbabb3e9f9a23b442e7/lib/contextpack.js)、章节时点账本、候选/版本分离和影响提示。
- 未复制段落三方合并，因为其空白归一化不适合要求精确保留周边正文的任意字符选区。
- 不复制对自由手工保存的重门禁；一致性检查/润色启发式不等于文学质量或语义正确性保证。

## dsh-long-novel-workbench

- 版本 0.7.2；快照 [`fae33646ad17565b64792e94be411f1d3fcf7e95`](https://github.com/micellince/dsh-long-novel-workbench/tree/fae33646ad17565b64792e94be411f1d3fcf7e95)，[MIT](https://github.com/micellince/dsh-long-novel-workbench/blob/fae33646ad17565b64792e94be411f1d3fcf7e95/LICENSE)。
- 借鉴正文优先阅读、问题/修改稿/采纳循环，理解了正文与旁路索引的分离；灵感首版未实现它的批注定位与段落数据库。
- 它的局部修改可确认到 paragraph/chapter 稿件，不宣称等价于灵感的精确任意选区。
- [0.7.2 发布记录](https://github.com/micellince/dsh-long-novel-workbench/blob/fae33646ad17565b64792e94be411f1d3fcf7e95/docs/releases/v0.7.2.md)：全文扩写/重写在两次确认后逐章备份并覆盖，不能概括为所有功能都只生成候选；暂停/中止运行状态不等于停止对话；该版本自述未跑自动测试。

## OpenWrite / dsh-openwrite

- 确认是 [LiPu-jpg/Openwrite](https://github.com/LiPu-jpg/Openwrite/tree/019e71dc7cfe0af3e128119fe486732a92b9214b)，主包 0.2.38，不是同名普通网页写作软件。
- main 快照 `019e71dc7cfe0af3e128119fe486732a92b9214b`，[Apache-2.0](https://github.com/LiPu-jpg/Openwrite/blob/019e71dc7cfe0af3e128119fe486732a92b9214b/LICENSE)。
- native-core 分支快照 [`89dd74c31d74d6408523b9b427f6250e6fff410a`](https://github.com/LiPu-jpg/Openwrite/tree/89dd74c31d74d6408523b9b427f6250e6fff410a)，同为 [Apache-2.0](https://github.com/LiPu-jpg/Openwrite/blob/89dd74c31d74d6408523b9b427f6250e6fff410a/LICENSE)。Studio panel 子包另标 [MIT](https://github.com/LiPu-jpg/Openwrite/blob/019e71dc7cfe0af3e128119fe486732a92b9214b/packages/studio-panel/LICENSE)；第三方依赖还有各自许可。
- 主骨架参考其 [安全选区修订](https://github.com/LiPu-jpg/Openwrite/blob/019e71dc7cfe0af3e128119fe486732a92b9214b/packages/studio-panel/src/client/manuscript-selection.ts)、[后端 revision service](https://github.com/LiPu-jpg/Openwrite/blob/89dd74c31d74d6408523b9b427f6250e6fff410a/tools/revision_service.py) 与 [可观测上下文组装](https://github.com/LiPu-jpg/Openwrite/blob/89dd74c31d74d6408523b9b427f6250e6fff410a/tools/chapter_assembler.py)。
- 采用「保存并冻结版本 → 精确选区 → 候选 → 预览 → 作者确认 → 再验版本 → 局部应用」；但灵感统一用 JS UTF-16 坐标，未移植其 Python Unicode 码点协议。
- 不照搬模型测试台、完整伏笔 DAG、多域审稿或生产文学评分门槛。源码分支与正式发行需区分，不能据此宣称全部能力已在用户环境可用。

## 本次取舍

围绕作者的实际工作保留：正文编辑、精确选段、候选入稿、可见上下文、章节时点、摘要失效和旧稿保护。其余复杂流水线留待真实使用反馈，而不是把四个系统拼在一起增加维护负担。
