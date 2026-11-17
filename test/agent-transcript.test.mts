// Pure journal folding. No hub, filesystem, model, credentials or editor runtime required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Transcript } from '../server/agent-transcript.mts';
import type { TranscriptReply } from '../server/agent-transcript.mts';
import { transcriptFixture } from './agent-render-fixture.mts';
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
  assert.deepEqual(prompts.map(s => s.seq), [1, 3]);
  assert.ok(prompts.every(s => s.folded === false && s.start < s.foldStart && s.foldEnd < s.end));
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
  for (const text of ['early\noutput\n', 'last\noutput\n', 'old\n', 'first\n', 'final\n']) assert.ok(r.text.includes(text), text);
  assert.equal(r.spans.filter(s => s.kind === 'message').length, 2, 'a folded update still ends the adjacent chunk run');
  assert.deepEqual(tr.journal, events);
});

test('thoughts fold while prompts and user/assistant messages of any length remain open and explicitly foldable', () => {
  const tr = new Transcript('folds');
  tr.apply(reply([
    chunk(1, 'private reasoning', { sessionUpdate: 'agent_thought_chunk' }),
    chunk(2, 'short response'),
    chunk(3, 'long output\n'.repeat(20), { messageId: 'long' }),
    chunk(4, 'x'.repeat(5000), { messageId: 'wide' }),
    chunk(5, 'long user input\n'.repeat(20), { sessionUpdate: 'user_message_chunk' }),
    { seq: 6, e: 'prompt', prompt: [{ type: 'text', text: 'long prompt\n'.repeat(20) }] },
  ]));
  const r = tr.render();
  assert.deepEqual(r.spans.map(s => [s.kind, s.folded]), [['thought', true], ['message', false], ['message', false], ['message', false], ['message', false], ['prompt', false]]);
  assert.ok(r.spans.every(s => s.start < s.foldStart && s.foldStart < s.foldEnd && s.foldEnd < s.end));
  assert.ok(r.text.includes('private reasoning'));
  assert.ok(r.text.includes('long output\n'.repeat(20)));
  assert.ok(r.text.includes('x'.repeat(5000)));
});

test('only the current plan is presented open at its own update position; every plan stays journaled', () => {
  const tr = new Transcript('plans');
  const events = [
    { seq: 1, e: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'Superseded task', status: 'in_progress' }] } },
    { seq: 2, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Inspect', status: 'in_progress' } },
    chunk(3, 'working'),
    { seq: 4, e: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'Current task', status: 'completed' }] } },
    { seq: 5, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', rawOutput: 'retained output' } },
  ];
  tr.apply(reply(events.slice(0, 3)));
  const before = tr.render();
  tr.apply(reply(events.slice(3), { from: 4 }));
  const r = tr.render(), plans = r.spans.filter(s => s.kind === 'plan'), s = plans[0], patch = r.patch!;
  assert.equal(plans.length, 1); assert.equal(s.seq, 4); assert.equal(s.lastSeq, 4);
  assert.equal(s.eventCount, 1); assert.equal(s.folded, false);
  assert.deepEqual(r.spans.map(s => [s.kind, s.seq]), [['tool', 2], ['message', 3], ['plan', 4]]);
  assert.equal(r.spans[0].lastSeq, 5);
  assert.match(r.text.slice(s.start, s.end), /\[completed\] Current task/);
  assert.doesNotMatch(r.text, /Superseded task|"sessionUpdate"|#\d+/);
  assert.equal(before.text.slice(0, patch.start) + patch.text + before.text.slice(patch.start + patch.remove), r.text);
  assert.deepEqual(tr.journal, events);
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
  assert.equal(r.spans.find(s => s.req === 2)?.status, 'resolved');
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
  assert.equal(r.text.split('\n')[0], 'Earlier history unavailable from hub; transcript starts at event 4.');
  assert.deepEqual(r.gaps, [{ after: 0, from: 4, head: 9 }]);
  assert.ok(r.text.includes('oldnew')); assert.ok(!r.text.includes('duplicate'));
  assert.deepEqual(tr.journal.map(e => e.seq), [4, 10]);
  tr.apply(reply([{ seq: 1, e: 'prompt', prompt: [{ type: 'text', text: 'new incarnation' }] }], { epoch: 101 }));
  r = tr.render();
  assert.equal(r.epoch, 101); assert.equal(r.head, 1); assert.equal(r.truncated, false);
  assert.doesNotMatch(r.text, /oldnew|Earlier history unavailable/);
  assert.equal((r.pending as Event[]).length, 0); assert.equal((r.resolved as Event[]).length, 0);
  assert.ok(r.spans[0].id.startsWith('101:'));
  tr.apply(reply([chunk(1, 'same-epoch explicit reset')], { epoch: 101, reset: true }));
  r = tr.render(); assert.equal(r.spans.length, 1); assert.equal(r.spans[0].kind, 'message');
  assert.ok(r.text.includes('same-epoch explicit reset')); assert.ok(!r.text.includes('new incarnation'));
  tr.reset(102); r = tr.render(); assert.equal(r.head, 0); assert.equal(r.spans.length, 0); assert.equal(r.epoch, 102);
});

test('a long replay retains at least 20 MiB verbatim in an open assistant message and reports replay time, events and bytes', t => {
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
  assert.equal(r.head, count); assert.equal(r.spans.length, 1); assert.equal(s.folded, false);
  assert.equal(r.text.slice(s.foldStart + 1, s.foldEnd + 1), expected);
  assert.equal(s.eventCount, count);
  assert.equal(tr.journal.length, count);
  for (let i = 0; i < count; i++) assert.strictEqual(tr.journal[i], events[i]);
  const { text: _text, ...meta } = r;
  assert.ok(Buffer.byteLength(JSON.stringify(meta)) < 4096, 'long content is not duplicated in buffer metadata');
  const openLines = r.text.split('\n').length;
  assert.ok(openLines > count, 'the assistant message stays open regardless of replay length');
  t.diagnostic(JSON.stringify({ ms: Number(ms.toFixed(2)), events: count, bytes, renderedBytes: Buffer.byteLength(r.text), openVisibleLines: openLines }));
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
  const limit = 1024 * 1024, tr = new Transcript('tool-history-budget'), payload = 'tool output\n'.repeat(100000);
  const events = [
    { seq: 1, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Large tool', content: [{ type: 'text', text: 'first\n' + payload }] } },
    { seq: 2, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content: [{ type: 'text', text: 'second\n' + payload }] } },
  ];
  tr.apply(reply(events));
  const r = tr.render(), span = r.spans[0], text = r.text.slice(span.start, span.end);
  assert.equal(r.spans.length, 1); assert.equal(span.eventCount, 2);
  assert.ok(text.length > limit); assert.ok(text.length <= 2 * limit);
  assert.equal(text.split('EVENT CONTENT TRUNCATED').length - 1, 2);
  assert.match(text, /first\ntool output\n/); assert.match(text, /second\ntool output\n/);
  assert.doesNotMatch(text, /### Update #/);
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
  assert.equal(prompt.seq, 3); assert.equal(tool.seq, 4);
  assert.ok(prompt.start < tool.start && tool.end <= r.text.length);
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
  assert.equal(r.spans.find(s => s.req === 2)!.status, 'resolved');
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

test('the shared mid-tool replay keeps conversation open and folds only inspectable auxiliary content', () => {
  const fixture = transcriptFixture(), tr = new Transcript('fixture');
  tr.apply(fixture);
  const r = tr.render(), at = (seq: number) => r.spans.find(s => s.seq === seq)!;
  assert.deepEqual(tr.journal, fixture.events, 'presentation never changes journal retention');
  assert.equal(r.text.split('\n')[0], `Earlier history unavailable from hub; transcript starts at event ${fixture.from}.`);
  assert.equal(r.text.match(/Earlier history unavailable/g)?.length, 1);
  assert.deepEqual(r.gaps, [{ after: 0, from: fixture.from, head: fixture.head }]);
  assert.equal(at(28680).kind, 'message'); assert.equal(at(28680).folded, false);
  assert.equal(at(27723).kind, 'prompt'); assert.equal(at(27723).folded, false);
  for (const seq of [27722, 27724, 27725, 27733]) {
    const span = at(seq);
    assert.equal(span.folded, true);
    assert.equal(r.text[span.foldStart], '\n'); assert.equal(r.text[span.foldEnd], '\n');
    assert.equal(r.text.slice(span.start, span.foldStart).split('\n').length, 1, 'a folded block leaves exactly its heading');
  }
  const orphan = at(27722), tool = at(27725), plan = at(27729), unknown = at(27733);
  const orphanHeading = r.text.slice(orphan.start, orphan.foldStart);
  assert.match(orphanHeading, /execute.*start not replayed/);
  assert.ok(!orphanHeading.includes('call_4Jr_fixture|fc_00ae_fixture'));
  assert.equal(tool.lastSeq, 27734); assert.ok(tool.start < plan.start);
  assert.equal(plan.folded, false); assert.equal(r.spans.filter(s => s.kind === 'plan').length, 1);
  assert.equal(r.spans.some(s => s.seq === 27726), false);
  assert.doesNotMatch(r.text, /\[in_progress\] Run the browser frame/);
  assert.match(r.text.slice(plan.start, plan.end), /\[completed\] Report the result/);
  const toolBody = r.text.slice(tool.foldStart + 1, tool.foldEnd + 1);
  assert.match(toolBody, /```sh\nnix build \.#edwin -L\n```\nthis derivation will be built:/);
  assert.ok(toolBody.includes('Browser checks passed.\n'));
  assert.doesNotMatch(toolBody, /\$ nix build|"sessionUpdate"|"toolCallId"/);
  assert.match(r.text.slice(unknown.start, unknown.foldStart), /future_update/);
  assert.match(r.text.slice(unknown.foldStart, unknown.foldEnd), /Inspectable future event data/);
  for (const span of r.spans) {
    const heading = r.text.slice(span.start, r.text.indexOf('\n', span.start));
    assert.doesNotMatch(heading, /#\d+|Update #/);
  }
  for (const kind of ['usage_update', 'session_info_update', 'config_option_update', 'current_mode_update']) {
    assert.equal(r.spans.some(s => s.kind === kind), false);
    assert.ok(!r.text.includes(`"${kind}"`));
  }
  assert.deepEqual(r.usage, { size: 4096, used: 768 });
  assert.deepEqual(r.sessionInfo, { title: 'Browser frame verified' });
  assert.equal(r.modeId, 'code');
  assert.equal(r.text.slice(at(28683).start, at(28683).end), 'Turn ended: end_turn\n\n');
  assert.equal(at(28683).foldStart, undefined);
});

test('invisible setup and control updates preserve message chunks, redaction and incremental publication', () => {
  const token = 'split-secret', replacement = '*'.repeat(token.length);
  const tr = new Transcript('continuity', text => text.replaceAll(token, replacement), token.length);
  tr.apply(reply([chunk(1, 'answer split-')]));
  let previous = tr.render();
  const controls = [
    { seq: 2, e: 'initialize', agentCapabilities: { promptCapabilities: { image: true } } },
    { seq: 3, e: 'session', sessionId: 'main', usage: { used: 1 } },
    { seq: 4, e: 'mode', modeId: 'ask' },
    { seq: 5, e: 'update', update: { sessionUpdate: 'usage_update', used: 2, size: 100 } },
    { seq: 6, e: 'update', update: { sessionUpdate: 'session_info_update', title: 'Current title' } },
    { seq: 7, e: 'update', update: { sessionUpdate: 'config_option_update', configOptions: [] } },
    { seq: 8, e: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } },
    { seq: 9, e: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } },
    { seq: 10, e: 'update', sessionId: 'child', update: { sessionUpdate: 'usage_update', used: 99 } },
    { seq: 11, e: 'update', sessionId: 'child', update: { sessionUpdate: 'session_info_update', title: 'Child title' } },
  ];
  tr.apply(reply(controls));
  const hidden = tr.render();
  assert.equal(hidden.text, previous.text);
  assert.equal(hidden.patch!.remove, 0); assert.equal(hidden.patch!.text, '');
  assert.deepEqual(tr.controls().usage, { used: 2, size: 100 });
  assert.deepEqual(tr.controls().sessionInfo, { title: 'Current title' });
  previous = hidden;
  tr.apply(reply([chunk(12, 'secret done')]));
  const next = tr.render(), patch = next.patch!;
  assert.equal(previous.text.slice(0, patch.start) + patch.text + previous.text.slice(patch.start + patch.remove), next.text);
  assert.equal(next.spans.length, 1);
  assert.deepEqual([next.spans[0].seq, next.spans[0].lastSeq, next.spans[0].eventCount], [1, 12, 2]);
  assert.equal(next.spans[0].folded, false);
  assert.ok(next.text.includes(`answer ${replacement} done`)); assert.ok(!next.text.includes(token));
  assert.equal(tr.journal.length, 12);
  tr.reset(101);
  assert.equal(tr.controls().usage, null); assert.equal(tr.controls().sessionInfo, null);
});

test('unknown outer and inner events each have one folded inspectable block without splitting their data', () => {
  const events = [
    { seq: 1, e: 'future_outer', detail: { keep: ['outer', 1] } },
    { seq: 2, e: 'update', update: { sessionUpdate: 'future_inner', detail: { keep: ['inner', 2] } } },
  ];
  const tr = new Transcript('future'); tr.apply(reply(events));
  const r = tr.render();
  assert.deepEqual(r.spans.map(s => [s.kind, s.folded]), [['future_outer', true], ['future_inner', true]]);
  for (const [i, span] of r.spans.entries()) {
    assert.match(r.text.slice(span.start, span.foldStart), new RegExp(span.kind));
    assert.deepEqual(JSON.parse(r.text.slice(span.foldStart + 1, span.foldEnd + 1)), events[i]);
  }
  assert.deepEqual(tr.journal, events);
});

test('turn endings and errors show explicit quiet reasons, never a protocol JSON block', () => {
  const events: Event[] = [
    ...['end_turn', 'cancelled', 'refusal', 'error'].map((stopReason, i) => ({ seq: i + 1, e: 'turn_end', stopReason })),
    { seq: 5, e: 'turn_error', error: { message: 'Agent refused the request', code: -1 } },
    { seq: 6, e: 'turn_error', reason: 'cancelled', message: 'Stopped by owner' },
    { seq: 7, e: 'turn_error', code: 'agent_error', message: 'Provider rejected the request' },
    { seq: 8, e: 'turn_error', code: 'interrupted', message: 'Hub shut down during the turn' },
    { seq: 9, e: 'turn_error', code: 'agent_exited', message: 'Agent process exited' },
  ];
  const tr = new Transcript('endings'); tr.apply(reply(events));
  const r = tr.render();
  for (const [i, span] of r.spans.entries()) {
    const text = r.text.slice(span.start, span.end);
    assert.equal(text.trimEnd().split('\n').length, 1);
    assert.doesNotMatch(text, /##|"seq"|"error"/); assert.equal(span.foldStart, undefined);
    assert.ok(text.includes(events[i].stopReason ?? events[i].reason ?? events[i].code ?? 'error'));
  }
  assert.match(r.text, /Agent refused the request/); assert.match(r.text, /Stopped by owner/);
  assert.deepEqual(tr.journal, events);
});

test('repeated plan replacement and hidden live events preserve patch boundaries and original tool positions', () => {
  const tr = new Transcript('reorder');
  const event = (seq: number, update: Event) => ({ seq, e: 'update', update });
  tr.apply(reply([
    event(1, { sessionUpdate: 'plan', entries: [{ content: 'old plan', status: 'pending' }] }),
    event(2, { sessionUpdate: 'tool_call', toolCallId: 't', title: 'A tool', rawInput: { command: 'printf before' }, content: [{ type: 'text', text: 'before' }] }),
    chunk(3, 'working'),
  ]));
  let previous = tr.render();
  const batches = [
    [event(4, { sessionUpdate: 'plan', entries: [{ content: 'middle plan', status: 'in_progress' }] })],
    [event(5, { sessionUpdate: 'usage_update', used: 10 })],
    [event(6, { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content: [{ type: 'text', text: 'after' }] })],
    [event(7, { sessionUpdate: 'plan', entries: [{ content: 'latest plan', status: 'completed' }] }), chunk(8, 'done')],
  ];
  for (const events of batches) {
    tr.apply(reply(events, { from: events[0].seq }));
    const r = tr.render(), patch = r.patch!, tool = r.spans.find(s => s.kind === 'tool')!, plan = r.spans.find(s => s.kind === 'plan')!;
    assert.equal(previous.text.slice(0, patch.start) + patch.text + previous.text.slice(patch.start + patch.remove), r.text);
    assert.equal(tool.seq, 2); assert.ok(tool.start < plan.start);
    assert.equal(plan.folded, false); assert.equal(r.spans.filter(s => s.kind === 'plan').length, 1);
    assert.doesNotMatch(r.text, /old plan/);
    if (r.head >= 6) {
      assert.equal(tool.lastSeq, 6);
      assert.match(r.text.slice(tool.start, tool.end), /```sh\nprintf before\n```\nbefore\nafter/);
    }
    for (const span of r.spans) assert.ok(span.start < span.end && span.end <= r.text.length);
    previous = r;
  }
  assert.doesNotMatch(previous.text, /middle plan/);
  assert.equal(tr.journal.length, 8);
});

test('tool content boundaries and command fences preserve outputs and exact diff slices without protocol duplication', () => {
  const diff = { type: 'diff', path: 'a.ts', oldText: 'old```bytes\n', newText: 'new\nbytes' };
  const events = [
    { seq: 1, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'command', title: 'Run checks', rawInput: { command: 'printf "```"', cwd: '/work/project' }, content: [
      { type: 'content', content: { type: 'text', text: '$ printf "```"\n' } },
      { type: 'content', content: { type: 'text', text: 'first output without newline' } },
      { type: 'content', content: { type: 'text', text: 'second output' } },
      diff,
    ] } },
    { seq: 2, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'command', rawOutput: 'later output' } },
    { seq: 3, e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'opaque-only-id', title: 'opaque-only-id', status: 'failed', rawOutput: 'orphan output' } },
    { seq: 4, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'fallback-command', title: 'Run fallback command', rawInput: null, content: [
      { type: 'content', content: { type: 'text', text: '$ printf fallback' } },
      { type: 'content', content: { type: 'text', text: 'fallback output' } },
    ] } },
  ];
  const tr = new Transcript('boundaries'); tr.apply(reply(events));
  const r = tr.render(), tool = r.spans[0], orphan = r.spans[1], d = tool.diffs[0];
  assert.equal(tool.folded, true);
  assert.match(r.text.slice(tool.start, tool.end), /````sh\nprintf "```"\n````\n/);
  assert.ok(r.text.slice(tool.start, tool.end).includes('/work/project'), 'other supplied command inputs remain inspectable');
  assert.match(r.text.slice(tool.start, tool.end), /first output without newline\nsecond output/);
  assert.ok(r.text.slice(tool.start, tool.end).includes('later output'));
  assert.equal(r.text.slice(d.oldStart, d.oldEnd), diff.oldText);
  assert.equal(r.text.slice(d.newStart, d.newEnd), diff.newText);
  assert.match(r.text.slice(orphan.start, orphan.foldStart), /^## tool \[failed\] — start not replayed$/);
  assert.ok(!r.text.slice(orphan.start, orphan.foldStart).includes('opaque-only-id'));
  const fallback = r.spans.find(s => s.seq === 4)!;
  assert.match(r.text.slice(fallback.start, fallback.end), /```sh\nprintf fallback\n```\nfallback output/);
  assert.deepEqual(tr.journal, events);
});
