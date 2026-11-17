// Shared rendering examples: bounded replay starts mid-tool, with control updates between message chunks.
import type { TranscriptReply } from '../server/agent-transcript.mts';
export function transcriptFixture(): TranscriptReply {
  return { epoch: 100, head: 28683, from: 27722, reset: false, truncated: true, events: [
    { seq: 27722, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_4Jr_fixture|fc_00ae_fixture', kind: 'execute', status: 'completed', rawOutput: 'An earlier build completed.\n' } },
    { seq: 27723, e: 'prompt', prompt: [{ type: 'text', text: 'Verify the browser frame, then report the result.\n\nKeep the transcript readable.' }] },
    { seq: 27724, e: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Check the frame and its shared buffer before reporting.\n' } } },
    { seq: 27725, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'ui-run', title: 'Recording successful single UI run', kind: 'execute', status: 'in_progress', rawInput: { command: 'nix build .#edwin -L' }, content: [
      { type: 'content', content: { type: 'text', text: '$ nix build .#edwin -L' } },
      { type: 'content', content: { type: 'text', text: 'this derivation will be built:\n  /nix/store/fixture-edwin.drv\n' } }
    ] } },
    { seq: 27726, e: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'Run the browser frame', status: 'in_progress', priority: 'high' }] } },
    { seq: 27727, e: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'progress', content: { type: 'text', text: 'The browser frame is ready. ' } } },
    { seq: 27728, e: 'update', update: { sessionUpdate: 'usage_update', size: 4096, used: 512, cost: { amount: 0.03, currency: 'USD' } } },
    { seq: 27729, e: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'Run the browser frame', status: 'completed', priority: 'high' }, { content: 'Report the result', status: 'completed', priority: 'medium' }] } },
    { seq: 27730, e: 'update', update: { sessionUpdate: 'session_info_update', title: 'Browser frame verification', updatedAt: '2026-11-18T12:00:00Z' } },
    { seq: 27731, e: 'update', update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', category: 'model', currentValue: 'openai-codex/gpt-6.1-sol', options: [{ value: 'openai-codex/gpt-6.1-sol', name: 'GPT 6.1' }] }] } },
    { seq: 27732, e: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } },
    { seq: 27733, e: 'update', update: { sessionUpdate: 'future_update', detail: { retained: 'Inspectable future event data' } } },
    { seq: 27734, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'ui-run', status: 'completed', rawOutput: 'Browser checks passed.\n' } },
    { seq: 28680, e: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { type: 'text', text: [
      '## Result', '', 'The browser frame and shared transcript are working.', '',
      '### Verified', '', '- Opened the session in a browser frame.', '- Followed new text at the tail.',
      '- Kept point unchanged while reading earlier text.', '- Opened a tool fold and inspected its output.',
      '- Displayed the current plan.', '- Kept protocol state out of the conversation.', '',
      '### Notes', '', 'The hub supplied only the available replay window.', 'Earlier tool input was not replayed.',
      'The visible transcript identifies that boundary.', '', '### Checks', '',
      'The command and its output are on separate lines.', 'The tool remains at its original position.',
      'The completed plan follows that tool.', 'The final answer stays open, even when it is long.', '',
      'No hub mutation was needed to inspect this transcript.', 'All supplied journal events remain available to Edwin.', ''
    ].join('\n') } } },
    { seq: 28681, e: 'update', update: { sessionUpdate: 'usage_update', size: 4096, used: 768 } },
    { seq: 28682, e: 'update', update: { sessionUpdate: 'session_info_update', title: 'Browser frame verified' } },
    { seq: 28683, e: 'turn_end', stopReason: 'end_turn' }
  ] };
}
export function sessionsFixture() {
  const row = (sid: string, state: string, updatedAt: number) => ({ sid, kind: 'acp', host: 'ex44', cwd: '/work/session-config', state, alive: !['done', 'exited'].includes(state), createdAt: 100, updatedAt,
    acp: { agent: 'omp', title: '', activity: 'none', pending: [] as { req: number; kind: string; title: string }[], headSeq: 0 } });
  const waiting = row('needs-answer', 'running', 1); waiting.acp.title = 'Approve the browser check'; waiting.acp.pending.push({ req: 7, kind: 'permission', title: 'Run browser' });
  const running = row('api_14e7_live', 'running', 2); running.acp.title = ('A long activity summary with several paragraphs.\n\n' + 'More detail. ').repeat(36); running.acp.activity = 'turn';
  const idle = row('ready', 'idle', 3);
  const exited = Array.from({ length: 8 }, (_, i) => { const s = row(`finished-${i + 1}`, i % 2 ? 'exited' : 'done', 20 - i); s.acp.title = `Finished check ${i + 1}`; return s; });
  return { sessions: [exited[0], idle, running, waiting, ...exited.slice(1)], observed: [
    { id: 'o_reported', host: 'remote', harness: 'codex', project: 'browser-ui', state: 'done', model: 'unknown', title: 'Reported browser work', lastAt: 4, pending: null },
  ] };
}
