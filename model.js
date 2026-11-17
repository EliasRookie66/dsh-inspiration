import { AssistantStreamAccumulator, BlockAssembler, createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { fail } from './service.js';

/** Direct, tool-free writing call, with exact inputs/outputs committed to a dedicated durable Session. */
export function makeModelRunner(ctx) {
  return async ({ model, prompt, signal, jobId, maxTokens, onText }) => {
    const sessionId = `inspiration-${jobId}`;
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId, agentOptions: { ...model, maxTokens }, signal });
    const session = ctx.sessions.get(sessionId);
    if (!session) { await handle.dispose(); fail('SESSION', 'Writing session could not be created'); }
    const stream = new AssistantStreamAccumulator(), assembler = new BlockAssembler();
    let terminal, text = '', settled = false, opened = false, cause, streamBytes = 0;
    try {
      session.append('turn/start', { turn: 1 });
      session.append('step/start', { turn: 1, step: 1 }); opened = true;
      session.append('request/header', { header: { config: { ...model, maxTokens } }, reason: 'initial' });
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      // Refuse an unlogged model call: every byte sent below is derived from this flushed Session.
      if (!await ctx.sessions.flush(session)) fail('SESSION', 'No session persistence is mounted / 未挂载会话持久化，已取消调用');
      signal.throwIfAborted();
      for await (const chunk of ctx.llm.stream({ ...model, maxTokens, signal, sessionId, messages: session.deriveMessages() })) {
        signal.throwIfAborted();
        streamBytes += Buffer.byteLength(JSON.stringify(chunk));
        if (streamBytes > 2 * 1024 * 1024) fail('STREAM_LIMIT', 'Model stream exceeds the 2 MiB safety limit / 模型响应流超过安全上限');
        stream.push({ time: Date.now(), chunk }); assembler.push(chunk);
        if (chunk.type === 'text-delta') { text += chunk.text; onText(text); signal.throwIfAborted(); }
        if (chunk.type === 'finish') terminal = chunk.reason;
      }
      if (!terminal) fail('STREAM', 'The model stream ended without a terminal result / 模型响应未完整结束');
      // A failed/truncated response remains an audit attempt, never a ready manuscript proposal.
      if (terminal.kind !== 'stop') fail(terminal.kind === 'max-tokens' ? 'TRUNCATED' : 'MODEL', terminal.failure?.message || `Generation did not finish (${terminal.kind}) / 未完整生成，请缩小任务`);
      const blocks = assembler.blocks();
      if (blocks.some(block => block.type === 'tool-call')) fail('MODEL', 'Unexpected tool call in writing-only mode');
      text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
      const message = createAssistantMessage({ content: blocks, source: { provider: model.provider, model: model.model, ...(assembler.replayState ? { replayState: assembler.replayState } : {}) } });
      session.append('assistant/message', { turn: 1, step: 1, message, stream: [...stream.snapshot()], ...(assembler.usage ? { usage: assembler.usage } : {}) }, { surfaceOp: 'append' });
      settled = true;
      signal.throwIfAborted();
      return { text, sessionId };
    } catch (error) {
      cause = error;
      if (opened && !settled) {
        session.append('assistant/attempt', { turn: 1, step: 1, stream: [...stream.snapshot()] });
      }
      throw error;
    } finally {
      try {
        if (opened) {
          session.append('step/end', { turn: 1, step: 1 });
          const reason = signal.aborted ? { kind: 'aborted', reason: { kind: 'user' } }
            : cause ? { kind: 'error', error: { code: String(cause.code || 'INSPIRATION_GENERATION'), message: String(cause.message || cause) } }
              : { kind: 'completed' };
          session.append('turn/end', { turn: 1, reason });
          await ctx.sessions.flush(session);
        }
      } finally { await handle.dispose(); }
    }
  };
}
