// Pure journal folding. No hub, filesystem, model, credentials or editor runtime required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Transcript } from '../server/agent-transcript.mts';
import type { TranscriptReply } from '../server/agent-transcript.mts';
type Event = Record<string, any>;
const reply = (events: Event[], overrides: Partial<TranscriptReply> = {}): TranscriptReply => ({ epoch: 100, head: events.at(-1)?.seq ?? 0, from: 1, reset: false, truncated: false, events, ...overrides });
const chunk = (seq: number, text: string, extra: Event = {}, event: Event = {}): Event => ({ seq, ts: seq, e: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...extra }, ...event });

test('Markdown inside an immutable prompt cannot create structural headings or tool targets', () => {
  const tr = new Transcript('s1');
  const malicious = '# Not a new prompt\n\n```md\n## Prompt #999\nTool: pretend /etc/secret:99\n```\nlast byte ☃';
  const blocks = [{ type: 'text', text: malicious }, { type: 'resource_link', uri: 'file:///agent/notes.md', name: 'notes' }, { type: 'resource', resource: { uri: 'edwin:region', mimeType: 'text/plain', text: '# region\n```' } }];
  const events = [{ seq: 1, e: 'prompt', prompt: blocks }, chunk(2, 'answer'), { seq: 3, e: 'prompt', prompt: [{ type: 'text', text: 'next' }] }];
  const before = JSON.stringify(events);
  tr.apply(reply(events));
  const r = tr.render(), prompts = r.spans.filter(s => s.kind === 'prompt');
  assert.equal(prompts.length, 2);
  assert.ok(r.text.includes(malicious));
  assert.ok(r.text.includes('file:///agent/notes.md'));
  assert.equal(r.text.slice(prompts[0].start, prompts[0].start + 12), '## Prompt #1');
  assert.equal(r.text.slice(prompts[1].start, prompts[1].start + 12), '## Prompt #3');
  assert.equal(r.spans.filter(s => s.kind === 'tool').length, 0);
  assert.ok(prompts[0].start < r.text.indexOf('Prompt #999') && r.text.indexOf('Prompt #999') < prompts[0].end);
  assert.equal(JSON.stringify(events), before);
  assert.deepEqual(tr.journal, events);
});

test('chunks coalesce only across contiguous matching message/session identities, without adding bytes', () => {
  const tr = new Transcript('chunks');
  tr.apply(reply([chunk(1, 'one'), chunk(2, '\ntwo', { messageId: null }), chunk(3, 'three', { messageId: 'm' }), chunk(4, 'four', { messageId: 'm' })]));
  tr.apply(reply([chunk(4, 'four', { messageId: 'm' }), chunk(5, 'five', { messageId: 'm' }), chunk(6, 'six', { messageId: 'm' }, { sessionId: 'subagent' }), { seq: 7, e: 'turn_end', stopReason: 'end_turn' }, chunk(8, 'new turn', { messageId: 'm' }, { sessionId: 'subagent' })], { from: 5 }));
  const r = tr.render(), messages = r.spans.filter(s => s.kind === 'message');
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map(s => [s.seq, s.lastSeq, s.eventCount]), [[1, 2, 2], [3, 5, 3], [6, 6, 1], [8, 8, 1]]);
  assert.ok(r.text.includes('one\ntwo'));
  assert.ok(r.text.includes('threefourfive'));
  assert.equal(tr.journal.length, 8);
  assert.equal(r.head, 8);
});

test('tool updates materialise one current folded block and retain replaced content, locations and all diffs', () => {
  const tr = new Transcript('tools');
  const oldDiff = { type: 'diff', path: '/work/a.ts', oldText: 'old\n', newText: 'first\n' };
  const newDiff = { type: 'diff', path: '/work/a.ts', oldText: 'first\n', newText: 'final\n' };
  const events = [
    { seq: 1, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit source', kind: 'edit', status: 'pending', locations: [{ path: '/work/a.ts', line: 2 }], rawInput: { path: '/work/a.ts' }, content: [{ type: 'content', content: { type: 'text', text: 'early\noutput\n' } }, oldDiff] } },
    chunk(2, 'before update', { messageId: 'm' }),
    { seq: 3, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', title: null, locations: [{ path: '/work/a.ts', line: 8 }], rawOutput: 'last\noutput\n', content: [newDiff] } },
    chunk(4, 'after update', { messageId: 'm' }),
  ];
  tr.apply(reply(events));
  const r = tr.render(), tools = r.spans.filter(s => s.kind === 'tool'), s = tools[0];
  assert.equal(tools.length, 1);
  assert.equal(s.seq, 1); assert.equal(s.lastSeq, 3);
  assert.equal(s.status, 'completed'); assert.equal(s.title, 'Edit source');
  assert.deepEqual(s.locations, [{ path: '/work/a.ts', line: 8 }]);
  assert.deepEqual(s.diffs.map((d: Event) => ({ type: 'diff', path: d.path, oldText: r.text.slice(d.oldStart, d.oldEnd), newText: r.text.slice(d.newStart, d.newEnd) })), [oldDiff, newDiff]);
  assert.ok(!('tool' in s));
  assert.equal(s.folded, true);
  assert.ok(s.foldStart > s.start && s.foldEnd > s.foldStart && s.foldEnd < s.end);
  assert.equal(r.text[s.foldStart], '\n'); assert.equal(r.text[s.foldEnd], '\n');
  assert.ok(r.text.slice(s.start, s.foldStart).includes('[completed]'));
  for (const text of ['early\noutput\n', 'last\noutput\n', 'old\n', 'first\n', 'final\n']) assert.ok(r.text.includes(text), text);
  assert.equal(r.spans.filter(s => s.kind === 'message').length, 2, 'a folded update still ends the adjacent chunk run');
  assert.deepEqual(tr.journal, events);
});

test('thoughts, long output and tool diffs are folded; short assistant messages remain visible', () => {
  const tr = new Transcript('folds');
  tr.apply(reply([
    chunk(1, 'private reasoning', { sessionUpdate: 'agent_thought_chunk' }),
    chunk(2, 'short response'),
    chunk(3, 'long output\n'.repeat(20), { messageId: 'long' }),
    chunk(4, 'x'.repeat(5000), { messageId: 'wide' }),
  ]));
  const r = tr.render();
  assert.deepEqual(r.spans.map(s => [s.kind, s.folded]), [['thought', true], ['message', false], ['message', true], ['message', true]]);
  assert.ok(r.text.includes('private reasoning'));
  assert.ok(r.text.includes('long output\n'.repeat(20)));
  assert.ok(r.text.includes('x'.repeat(5000)));
});

test('plan updates show the latest plan with earlier plans retained inside its history fold', () => {
  const tr = new Transcript('plans');
  const first = [{ content: 'Inspect', status: 'in_progress', priority: 'high' }];
  const current = [{ content: 'Inspect', status: 'completed', priority: 'high' }, { content: 'Implement', status: 'in_progress', priority: 'medium' }];
  tr.apply(reply([{ seq: 1, e: 'update', update: { sessionUpdate: 'plan', entries: first } }]));
  tr.apply(reply([{ seq: 2, e: 'update', update: { sessionUpdate: 'plan', entries: current } }], { from: 2 }));
  const r = tr.render(), plans = r.spans.filter(s => s.kind === 'plan'), s = plans[0];
  assert.equal(plans.length, 1); assert.equal(s.lastSeq, 2);
  assert.equal(s.eventCount, 2);
  const visible = r.text.slice(s.start, s.foldStart);
  assert.match(visible, /\[completed\] Inspect/); assert.match(visible, /\[in_progress\] Implement/);
  assert.doesNotMatch(visible, /\[in_progress\] Inspect/);
  assert.ok(r.text.slice(s.foldStart, s.foldEnd).includes(JSON.stringify('in_progress')));
  assert.equal(tr.journal.length, 2);
});

test('setup, current mode/config updates and future variants remain available for steering and inspection', () => {
  const tr = new Transcript('config');
  const modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] };
  const initial = [{ id: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }];
  const current = [{ ...initial[0], currentValue: 'b' }];
  const events = [
    { seq: 1, e: 'session', sessionId: 'acp-s', via: 'new', modes, configOptions: initial },
    { seq: 2, e: 'update', update: { sessionUpdate: 'config_option_update', configOptions: current } },
    { seq: 3, e: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } },
    { seq: 4, e: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact context' }] } },
    { seq: 5, e: 'update', update: { sessionUpdate: 'future_update', payload: { keep: 'all future bytes ☃' } } },
    { seq: 6, e: 'future_event', unrecognised: ['also retained', { n: 42 }] },
    { seq: 7, e: 'mode', modeId: 'ask' },
  ];
  tr.apply(reply(events));
  const r = tr.render();
  assert.deepEqual(r.configOptions, current); assert.deepEqual(r.modes, modes); assert.equal(r.modeId, 'ask');
  assert.deepEqual(r.availableCommands, [{ name: 'compact', description: 'Compact context' }]);
  assert.ok(r.text.includes('all future bytes ☃')); assert.ok(r.text.includes('also retained'));
  assert.equal(r.spans.find(s => s.seq === 5)?.kind, 'future_update');
  assert.equal(r.spans.find(s => s.seq === 6)?.kind, 'future_event');
  assert.deepEqual(tr.journal, events);
});

test('initialization and later session capability metadata remain authoritative and reset with the epoch', () => {
  const tr = new Transcript('capabilities'), initial = { image: true, embeddedContext: true };
  tr.apply(reply([
    { seq: 1, e: 'initialize', agentCapabilities: { promptCapabilities: initial } },
    { seq: 2, e: 'session', sessionId: 's' },
  ]));
  assert.deepEqual(tr.render().promptCapabilities, initial);
  tr.apply(reply([{ seq: 3, e: 'session', via: 'resume', promptCapabilities: { audio: true }, modes: null }], { from: 3 }));
  assert.deepEqual(tr.render().promptCapabilities, { audio: true });
  assert.equal(tr.render().modeId, null);
  tr.apply(reply([], { epoch: 200 }));
  assert.equal(tr.render().promptCapabilities, null);
});

test('pinned pending requests deduplicate, late pinned events retain sequence position and resolutions survive', () => {
  const tr = new Transcript('pending');
  const permission = { seq: 2, e: 'permission', toolCall: { toolCallId: 't', title: 'Run command' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] };
  const elicitation = { seq: 5, e: 'elicitation', request: { mode: 'url', message: 'Authenticate', url: 'https://example.invalid/full?keep=this', elicitationId: 'auth' } };
  tr.apply(reply([permission, chunk(10, 'recent')], { head: 10, from: 8, truncated: true }));
  tr.apply(reply([permission, elicitation, { seq: 11, e: 'permission_resolved', req: 2, by: 'user', outcome: { outcome: 'selected', optionId: 'allow' } }], { head: 11, from: 11 }));
  let r = tr.render();
  assert.deepEqual(tr.journal.map(e => e.seq), [2, 5, 10, 11]);
  assert.deepEqual((r.pending as Event[]).map(e => e.req), [5]);
  assert.deepEqual((r.resolved as Event[]).map(e => e.req), [2]);
  assert.deepEqual(tr.journal.find(e => e.seq === 2)?.options, permission.options);
  assert.equal(tr.journal.find(e => e.seq === 11)?.outcome.optionId, 'allow');
  assert.equal((r.resolved as Event[])[0].by, 'user');
  assert.equal((r.pending as Event[])[0].request.url, elicitation.request.url);
  assert.match(r.text, /permission \[resolved\]/);
  tr.apply(reply([{ seq: 12, e: 'elicitation_resolved', req: 5, by: 'user', response: { action: 'accept' } }, { seq: 13, e: 'elicitation_complete', elicitationId: 'auth' }], { from: 12 }));
  r = tr.render();
  assert.equal((r.pending as Event[]).length, 0);
  assert.equal((r.resolved as Event[]).find(e => e.req === 5)?.status, 'complete');
  assert.equal(r.epoch, 100);
});

test('epoch, explicit resets, deduplication and the hub replay ceiling are explicit', () => {
  const tr = new Transcript('reset');
  tr.apply(reply([chunk(4, 'old')], { head: 9, from: 4, truncated: true }));
  tr.apply(reply([chunk(4, 'duplicate'), chunk(10, 'new')], { head: 12, from: 10 }));
  let r = tr.render();
  assert.equal(r.head, 12); assert.equal(r.truncated, true); assert.equal(r.from, 4);
  assert.match(r.text, /HISTORY TRUNCATED BY HUB/); assert.match(r.text, /no backward pagination/);
  assert.ok(r.text.includes('oldnew')); assert.ok(!r.text.includes('duplicate'));
  assert.deepEqual(tr.journal.map(e => e.seq), [4, 10]);
  tr.apply(reply([{ seq: 1, e: 'prompt', prompt: [{ type: 'text', text: 'new incarnation' }] }], { epoch: 101 }));
  r = tr.render();
  assert.equal(r.epoch, 101); assert.equal(r.head, 1); assert.equal(r.truncated, false);
  assert.doesNotMatch(r.text, /oldnew|HISTORY TRUNCATED/);
  assert.equal((r.pending as Event[]).length, 0); assert.equal((r.resolved as Event[]).length, 0);
  assert.ok(r.spans[0].id.startsWith('101:'));
  tr.apply(reply([chunk(1, 'same-epoch explicit reset')], { epoch: 101, reset: true }));
  r = tr.render(); assert.equal(r.spans.length, 1); assert.equal(r.spans[0].kind, 'message');
  assert.ok(r.text.includes('same-epoch explicit reset')); assert.ok(!r.text.includes('new incarnation'));
  tr.reset(102); r = tr.render(); assert.equal(r.head, 0); assert.equal(r.spans.length, 0); assert.equal(r.epoch, 102);
});

test('a long replay retains at least 20 MiB verbatim and reports replay time, events, bytes and folded visible lines', t => {
  const tr = new Transcript('long-replay'), events: Event[] = [], parts: string[] = [];
  const count = 8192;
  for (let i = 0; i < count; i++) {
    const text = `event-${String(i).padStart(5, '0')}:` + 'abcdefghijklmnop'.repeat(191) + '\n';
    parts.push(text); events.push(chunk(i + 1, text, { messageId: 'one-long-message' }));
  }
  const expected = parts.join(''), bytes = Buffer.byteLength(expected);
  assert.ok(bytes >= 20 * 1024 * 1024);
  const begin = performance.now();
  tr.apply(reply(events)); const r = tr.render();
  const ms = performance.now() - begin, s = r.spans[0];
  assert.equal(r.head, count); assert.equal(r.spans.length, 1); assert.equal(s.folded, true);
  assert.equal(r.text.slice(s.foldStart + 1, s.foldEnd + 1), expected);
  assert.equal(s.eventCount, count);
  assert.equal(tr.journal.length, count);
  for (let i = 0; i < count; i++) assert.strictEqual(tr.journal[i], events[i]);
  const { text: _text, ...meta } = r;
  assert.ok(Buffer.byteLength(JSON.stringify(meta)) < 4096, 'long content is not duplicated in buffer metadata');
  const lineCount = (text: string) => { let n = 0; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };
  const visibleLines = lineCount(r.text) + 1 - lineCount(r.text.slice(s.foldStart + 1, s.foldEnd + 1));
  assert.ok(visibleLines <= 8, `folded transcript has ${visibleLines} visible lines`);
  t.diagnostic(JSON.stringify({ ms: Number(ms.toFixed(2)), events: count, bytes, renderedBytes: Buffer.byteLength(r.text), foldedVisibleLines: visibleLines }));
});

test('many oversized prompt bodies have an explicit per-event bound without overflowing metadata wire frames', () => {
  const limit = 1024 * 1024, tr = new Transcript('prompt-budget'), payload = 'context\n'.repeat(180000) + 'discarded-tail';
  const events = Array.from({ length: 19 }, (_, i) => ({ seq: i + 1, e: 'prompt', prompt: [{ type: 'text', text: `${i}:` + payload }] }));
  tr.apply(reply(events));
  const rendered = tr.render();
  assert.ok(Buffer.byteLength(rendered.text) > 16 * 1024 * 1024, 'ordinary aggregate history is not capped');
  assert.ok(Buffer.byteLength(JSON.stringify({ ...rendered, text: undefined })) < 16 * 1024 * 1024, 'the /edit frame limit applies to structure too');
  assert.equal(rendered.spans.length, 19);
  for (const span of rendered.spans) {
    const text = rendered.text.slice(span.start, span.end);
    assert.ok(text.length <= limit, `event #${span.seq} exceeds its UTF-16 budget`);
    assert.match(text, /EVENT CONTENT TRUNCATED/);
    assert.doesNotMatch(text, /discarded-tail/);
  }
  assert.strictEqual(tr.journal[18], events[18], 'the cap affects presentation, not the journal');
});

test('foreign-session mode/config and plan updates cannot replace the main session state', () => {
  const tr = new Transcript('scopes');
  tr.apply(reply([
    { seq: 1, e: 'session', modes: { currentModeId: 'ask' }, configOptions: [{ id: 'model', currentValue: 'main-model' }] },
    { seq: 2, e: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'main plan', status: 'in_progress' }] } },
    { seq: 3, e: 'update', sessionId: 'child', update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'child-model' }] } },
    { seq: 4, e: 'update', sessionId: 'child', update: { sessionUpdate: 'current_mode_update', currentModeId: 'auto' } },
    { seq: 5, e: 'update', sessionId: 'child', update: { sessionUpdate: 'plan', entries: [{ content: 'child plan', status: 'pending' }] } },
  ]));
  const rendered = tr.render();
  assert.deepEqual(rendered.configOptions, [{ id: 'model', currentValue: 'main-model' }]); assert.equal(rendered.modeId, 'ask');
  assert.ok(rendered.text.includes('main plan')); assert.ok(rendered.text.includes('child plan'));
  assert.equal(rendered.spans.filter(s => s.kind === 'plan').length, 2);
});

test('all event presentations share one 1 Mi UTF-16 budget across literal content, JSON and summaries', () => {
  const limit = 1024 * 1024, payload = '😀'.repeat(600000) + 'discarded-tail', tr = new Transcript('event-budget');
  const diff = { type: 'diff', path: '/work/retained.ts', oldText: 'before\n', newText: 'after\n' };
  const events = [
    { seq: 1, e: 'prompt', prompt: [{ type: 'text', text: payload }] },
    chunk(2, payload),
    { seq: 3, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Large output', content: [diff, { type: 'text', text: payload }], rawOutput: payload } },
    { seq: 4, e: 'update', update: { sessionUpdate: 'plan', entries: [{ content: payload, status: 'in_progress' }] } },
    { seq: 5, e: 'future_event', payload },
    { seq: 6, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'large-title', title: payload, content: [{ type: 'text', text: payload }] } },
    { seq: 7, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'partial-diff', content: [{ ...diff, oldText: payload }] } },
  ];
  tr.apply(reply(events));
  const r = tr.render();
  assert.equal(r.spans.length, events.length);
  for (const span of r.spans) {
    const text = r.text.slice(span.start, span.end);
    assert.ok(text.length <= limit, `${span.kind} #${span.seq} exceeds its UTF-16 budget`);
    assert.match(text, /EVENT CONTENT TRUNCATED/);
    assert.doesNotMatch(text, /discarded-tail/);
    if (span.foldStart !== undefined) {
      assert.equal(r.text[span.foldStart], '\n'); assert.equal(r.text[span.foldEnd], '\n');
      assert.ok(span.start < span.foldStart && span.foldEnd < span.end);
    }
  }
  const retained = r.spans.find(s => s.seq === 3)!.diffs[0];
  assert.equal(r.text.slice(retained.oldStart, retained.oldEnd), diff.oldText);
  assert.equal(r.text.slice(retained.newStart, retained.newEnd), diff.newText);
  assert.deepEqual(r.spans.find(s => s.seq === 7)!.diffs, [], 'a clipped diff is not offered as a complete diff');
  assert.deepEqual(tr.journal, events);
});

test('the event budget bounds tool history entries without capping their combined block', () => {
  const limit = 1024 * 1024, tr = new Transcript('tool-history-budget'), payload = 'tool output\n'.repeat(70000);
  const events = [
    { seq: 1, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Large tool', content: [{ type: 'text', text: 'first\n' + payload }] } },
    { seq: 2, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content: [{ type: 'text', text: 'second\n' + payload }] } },
  ];
  tr.apply(reply(events));
  const r = tr.render(), span = r.spans[0], text = r.text.slice(span.start, span.end);
  assert.equal(r.spans.length, 1); assert.equal(span.eventCount, 2);
  assert.ok(text.length > limit); assert.ok(text.length <= 2 * limit);
  assert.equal(text.split('EVENT CONTENT TRUNCATED').length - 1, 2);
  assert.match(text, /### Update #1\nfirst\n/); assert.match(text, /### Update #2\nsecond\n/);
  assert.deepEqual(tr.journal, events);
});

test('incremental publication patches reconstruct text and preserve structural positions across successive replies', () => {
  const tr = new Transcript('incremental');
  const oldDiff = { type: 'diff', path: '/work/a.ts', oldText: 'old\n', newText: 'first\n' };
  const newDiff = { type: 'diff', path: '/work/a.ts', oldText: 'first\n', newText: 'final\n' };
  tr.apply(reply([
    { seq: 1, e: 'prompt', prompt: [{ type: 'text', text: 'immutable prompt' }] },
    { seq: 2, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Edit', content: [oldDiff] } },
    chunk(3, 'first answer'),
  ]));
  let previous = tr.render();
  const publish = () => {
    const next = tr.render(), patch = next.patch!;
    assert.ok(patch);
    assert.equal(patch.previousHead, previous.head); assert.equal(patch.previousEpoch, previous.epoch);
    assert.equal(previous.text.slice(0, patch.start) + patch.text + previous.text.slice(patch.start + patch.remove), next.text);
    for (const span of next.spans) {
      assert.equal(next.text.slice(span.start, span.start + 3), '## ');
      assert.ok(span.start < span.end && span.end <= next.text.length);
      if (span.foldStart !== undefined) {
        assert.equal(next.text[span.foldStart], '\n'); assert.equal(next.text[span.foldEnd], '\n');
        assert.ok(span.start < span.foldStart && span.foldEnd < span.end);
      }
    }
    const tool = next.spans.find(s => s.kind === 'tool');
    if (tool) for (const [i, d] of tool.diffs.entries()) {
      const expected = [oldDiff, newDiff][i];
      assert.equal(next.text.slice(d.oldStart, d.oldEnd), expected.oldText);
      assert.equal(next.text.slice(d.newStart, d.newEnd), expected.newText);
    }
    previous = next;
    return patch;
  };
  tr.apply(reply([{ seq: 4, e: 'prompt', prompt: [{ type: 'text', text: 'second prompt' }] }], { from: 4 }));
  const oldEnd = previous.text.length, append = publish();
  assert.equal(append.start, oldEnd); assert.equal(append.remove, 0);
  tr.apply(reply([chunk(5, 'second answer')], { from: 5 })); publish();
  tr.apply(reply([chunk(6, ' continued')], { from: 6 }));
  publish();
  assert.match(previous.text, /second answer continued/);
  tr.apply(reply([{ seq: 7, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content: [newDiff] } }], { from: 7 }));
  publish();
  tr.apply(reply([], { head: 8, from: 8 })); const unchanged = publish();
  assert.equal(unchanged.remove, 0); assert.equal(unchanged.text, '');
  tr.apply(reply([chunk(1, 'replacement epoch')], { epoch: 200 })); publish();
  assert.equal(previous.epoch, 200); assert.doesNotMatch(previous.text, /immutable prompt/);
});

test('assembled split-token redaction precedes navigation and exact tool-diff offsets', () => {
  const token = 'secret-token-for-transcript', replacement = '[redacted]'.padEnd(token.length, '•');
  const clean = (text: string) => text.replaceAll(token, replacement), tr = new Transcript(token, clean);
  tr.apply(reply([chunk(1, 'answer secret-token-')]));
  const before = tr.render();
  const diff = { type: 'diff', path: '/work/a.ts', oldText: `old ${token}\n`, newText: `new ${token}\n` };
  tr.apply(reply([
    chunk(2, 'for-transcript done'),
    { seq: 3, e: 'prompt', prompt: [{ type: 'text', text: `next ${token}` }] },
    { seq: 4, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: token, content: [diff] } },
  ], { from: 2 }));
  const r = tr.render(), patch = r.patch!;
  assert.equal(before.text.slice(0, patch.start) + patch.text + before.text.slice(patch.start + patch.remove), r.text);
  assert.ok(!r.text.includes(token)); assert.ok(!patch.text.includes(token));
  assert.ok(r.text.includes(`answer ${replacement} done`));
  assert.ok(r.text.startsWith(`# Agent: ${replacement}\n`));
  const prompt = r.spans.find(s => s.kind === 'prompt')!, tool = r.spans.find(s => s.kind === 'tool')!;
  assert.equal(r.text.slice(prompt.start, prompt.start + 12), '## Prompt #3');
  assert.equal(r.text.slice(tool.start, tool.start + 8), '## Tool:');
  assert.ok(r.text.slice(tool.start, tool.foldStart).includes(replacement));
  const renderedDiff = tool.diffs[0];
  assert.equal(r.text.slice(renderedDiff.oldStart, renderedDiff.oldEnd), clean(diff.oldText));
  assert.equal(r.text.slice(renderedDiff.newStart, renderedDiff.newEnd), clean(diff.newText));
  for (const span of r.spans) {
    assert.equal(r.text[span.foldStart], '\n'); assert.equal(r.text[span.foldEnd], '\n');
    assert.ok(span.start < span.foldStart && span.foldEnd < span.end);
  }
});

test('authoritative pending reconciliation marks unavailable resolutions without inventing an outcome', () => {
  let cleanCalls = 0;
  const tr = new Transcript('lost-resolution', text => { cleanCalls++; return text; });
  const permission = (seq: number): Event => ({ seq, e: 'permission', toolCall: { toolCallId: `t${seq}`, title: 'Run' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] });
  tr.apply(reply([permission(2), { seq: 5, e: 'elicitation', request: { message: 'Choose', mode: 'form' } }, chunk(10, 'recent')], { head: 10, from: 8, truncated: true }));
  const initial = tr.controls();
  assert.equal(cleanCalls, 0, 'current requests are available before any history is rendered');
  assert.deepEqual(initial.pending.map(e => e.req), [2, 5]);
  assert.deepEqual(initial.pending[0].options, permission(2).options);
  const before = tr.render();
  tr.reconcilePending([{ req: 5, kind: 'elicitation' }]);
  const callsBeforeControls = cleanCalls, controls = tr.controls();
  assert.equal(cleanCalls, callsBeforeControls, 'request projection does not render history');
  let r = tr.render();
  assert.deepEqual(controls.pending, r.pending); assert.deepEqual(controls.resolved, r.resolved);
  assert.deepEqual(r.pending.map(e => e.req), [5]);
  assert.deepEqual(r.resolved.map(e => [e.req, e.status]), [[2, 'unavailable']]);
  assert.equal(r.resolved[0].by, undefined); assert.equal(r.resolved[0].seq, undefined);
  assert.match(r.text, /permission \[no longer pending; resolution unavailable\] #2/);
  assert.equal(r.spans.find(s => s.req === 2)!.status, 'unavailable');
  assert.equal(before.text.slice(0, r.patch!.start) + r.patch!.text + before.text.slice(r.patch!.start + r.patch!.remove), r.text);
  tr.apply(reply([permission(3), permission(11)], { head: 11, from: 11 }));
  r = tr.render();
  assert.deepEqual(r.pending.map(e => e.req), [5, 11], 'new requests are not judged against an older registry');
  assert.deepEqual(r.resolved.map(e => [e.req, e.status]), [[2, 'unavailable'], [3, 'unavailable']], 'late pinned events retain authoritative absence through refolding');
  tr.reconcilePending([{ req: 11, kind: 'permission' }]);
  r = tr.render();
  assert.deepEqual(r.pending.map(e => e.req), [11]);
  assert.equal(r.resolved.find(e => e.req === 5)!.status, 'unavailable');
  tr.apply(reply([{ seq: 12, e: 'permission_resolved', req: 2, by: 'user', outcome: { outcome: 'selected', optionId: 'allow' } }], { from: 12 }));
  r = tr.render();
  assert.equal(r.resolved.find(e => e.req === 2)!.status, 'resolved');
  assert.equal(r.resolved.find(e => e.req === 2)!.by, 'user');
  assert.match(r.text, /permission \[resolved\] #2/);
  assert.equal(r.resolved.find(e => e.req === 3)!.status, 'unavailable');
  tr.apply(reply([permission(2)], { reset: true }));
  r = tr.render();
  assert.deepEqual(r.pending.map(e => e.req), [2]); assert.equal(r.resolved.length, 0);
  assert.doesNotMatch(r.text, /resolution unavailable/);
});

test('growing assistant messages publish only new text, not their already displayed body', () => {
  const tr = new Transcript('message-appends', text => text, 63), opening = 'earlier output\n'.repeat(10000);
  tr.apply(reply([chunk(1, opening)]));
  let prior = tr.render();
  for (let seq = 2; seq < 12; seq++) {
    const addition = `visible chunk ${seq}\n` + 'streaming text\n'.repeat(500);
    tr.apply(reply([chunk(seq, addition)]));
    const next = tr.render(), patch = next.patch!;
    assert.equal(patch.remove, 0, 'ordinary streaming never deletes already displayed text');
    assert.equal(patch.text, addition, 'the edit payload is independent of the growing message history');
    assert.equal(prior.text.slice(0, patch.start) + patch.text + prior.text.slice(patch.start), next.text);
    assert.equal(next.spans[0].eventCount, seq);
    assert.equal(next.text[next.spans[0].foldEnd], '\n');
    prior = next;
  }
  assert.equal(prior.spans.length, 1);
  assert.ok(prior.text.includes(opening));
});

test('oversized Unicode events truncate without publishing unpaired UTF-16 surrogates', () => {
  const tr = new Transcript('unicode-budget'), large = '😀'.repeat(1024 * 1024);
  tr.apply(reply([0, 1].map(n => ({ seq: n + 1, e: 'prompt', prompt: [{ type: 'text', text: 'x'.repeat(n) + large }] }))));
  const view = tr.render();
  assert.equal(view.text.isWellFormed(), true);
  for (const span of view.spans) {
    const text = view.text.slice(span.start, span.end);
    assert.ok(text.length <= 1024 * 1024);
    assert.match(text, /EVENT CONTENT TRUNCATED/);
  }
});
