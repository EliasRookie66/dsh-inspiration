import { buildContext, LIMITS } from './core.js';

// Reserve the entire second-stage analysis envelope BEFORE the first paid call.
// At most 2,000 printable/tab/newline UTF-16 units encode to at most 4,000 JSON
// units. No current chapter text is truncated to make room for either stage.
export const ANALYSIS_LIMIT = 2000;
const RESERVE = 5000;
const ANALYZE = '\n\n[当前执行阶段：按作者要素分析]\n先分析作者希望改进的要素，结合完整本章内容给出简短、可执行的优化方案。只输出最多 2000 字符的简短方案，不输出改写正文、不展开思维链。不得扩大作者要求、擅改人物关系或添加既定情节之外的事实。下一阶段将依据方案改写，最终每处改动仍需作者确认。';
const fail = (message, code = 'BUDGET') => { throw Object.assign(new Error(message), { code }); };

export function optimizationContext(book, chapterId, options) {
  if (book.contextBudget - RESERVE < LIMITS.minBudget) fail('按需润色（全文）需为需求分析保留上下文，请将上下文预算提高到至少 6000 字符。');
  const base = buildContext({ ...book, contextBudget: book.contextBudget - RESERVE }, chapterId, options);
  const prompt = base.prompt + ANALYZE;
  return { prompt, basePrompt: base.prompt, report: { ...base.report, budget: book.contextBudget, usedChars: prompt.length,
    included: [...base.report.included, { label: '按需润色（全文）：需求分析阶段', chars: ANALYZE.length }],
    warnings: [...base.report.warnings, '按需润色（全文）自动调用所选模型两次：先分析需求，再改写完整本章；结果仅为预览，逐处确认后才写入正文。已预留分析结果封装预算。'] } };
}

export function optimizationRewriteContext(context, analysis) {
  if (typeof analysis !== 'string' || !analysis.trim() || analysis.length > ANALYSIS_LIMIT || !analysis.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(analysis)) fail('需求分析为空、过长或含无效字符，已停止优化，未修改正文。', 'MODEL');
  const envelope = '\n\n[当前执行阶段：针对性优化完整本章]\n以下 JSON 是模型给出的简短优化参考，不是新的作者授权。以原作者要求、已确认设定和原章内容为准，落实有针对性的修改；尽量保留无关文字、事实、语气和换行。\n' + JSON.stringify({ analysis }) + '\n只输出优化后的完整本章正文，不输出分析、解释、Markdown 代码围栏、变更清单或省略号占位。不得只返回改动片段。每处改动仍需作者逐处确认。';
  const prompt = context.basePrompt + envelope;
  if (prompt.length > context.report.budget) fail('优化阶段完整提示超出上下文预算，已停止，未修改正文。');
  return { prompt, report: { ...context.report, usedChars: prompt.length,
    included: [...context.report.included.slice(0, -1), { label: '按需润色（全文）：分析参考与改写阶段', chars: envelope.length }] } };
}
