/* JSON-RPC 2.0 as language servers speak it (docs/steps.md, "JSON-RPC for language servers"): messages framed
   by a Content-Length header, requests matched to their responses by id, cancellation and timeouts. The frame's
   language client (lsp-sessions) runs a server through Ed.proc and joins its pipes to a connection made here:
   the child's output goes to receive, and what the connection sends is written to the child's input.

   Pure text and timers: nothing here starts a process or reaches the network, so the image's replay (R16.15) is
   kept out where the process starts, in Ed.proc.

   Content-Length counts the body's UTF-8 bytes, while the hosts hand a child's output over as strings (decoded
   with what a chunk ends mid-character carried to the next). The bytes are counted from the UTF-16 code units: one
   below U+0080, two below U+0800, two for each half of a surrogate pair (four for the pair), else three. A chunk
   may end anywhere, a pair's halves included: the count does not depend on where.

   A stream that breaks the framing (no or a bad Content-Length, a header past its bound, a body past its bound
   or ending inside a character) cannot be found again: the connection closes, every request waiting on it is
   rejected, and the session decides what to do with the server. A body that is not JSON, or not a message, is
   framed correctly and only dropped. No message's body ever goes into an error or a log: a server's payload holds
   file text. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed;
const S = L.S, { SchemeError } = S;

/* lsp-error: a broken stream, a closed connection, a server's error answer, a cancelled request. A request that
   waits past its time is timeout. */
S.defineConditionType('lsp-error', 'error');

/* The header block's bound (a server's is two short lines) and the body's (a large file's semantic tokens or a
   workspace's symbols stay well under it). */
const HEADER_MAX = 4096;
const BODY_MAX = 64 * 1024 * 1024;
/* A request's time when its caller names none; 0 or Infinity is none. A time past the longest setTimeout takes
   (2^31 - 1 ms, about 24.8 days) is none too: the hosts would fire it at once. */
const DEFAULT_TIMEOUT = 10_000;
const TIMEOUT_MAX = 2 ** 31 - 1;

/* JSON-RPC's and LSP's error codes this file answers with. */
const METHOD_NOT_FOUND = -32601, INTERNAL_ERROR = -32603;

const lspError = (msg: string, code?: number) => new SchemeError('lsp-error', msg, code === undefined ? [] : [code]);

/* UTF-8 bytes of the code units of S from I to J. */
function bytesOf(s: string, i = 0, j = s.length): number {
  let n = 0;
  for (; i < j; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 || (c >= 0xD800 && c <= 0xDFFF) ? 2 : 3;
  }
  return n;
}

/* A message framed for a server's input. */
function encode(msg: unknown): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${bytesOf(body)}\r\n\r\n${body}`;
}

/* The length a header block gives, or why it gives none. */
function lengthOf(head: string): number | string {
  if (!/^[\x20-\x7e\r\n]*$/.test(head)) return 'a header that is not ASCII';
  let len: number | null = null;
  for (const line of head.split('\r\n')) {
    const m = /^([!-9;-~]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!m) return 'a header line that is not NAME: VALUE';
    if (m[1].toLowerCase() !== 'content-length') continue;   // Content-Type: LSP has only utf-8
    if (len !== null) return 'two Content-Length headers';
    if (!/^[0-9]{1,10}$/.test(m[2])) return 'a Content-Length that is not a number';
    len = Number(m[2]);
  }
  if (len === null) return 'no Content-Length header';
  if (len > BODY_MAX) return `a body of ${len} bytes, past ${BODY_MAX}`;
  return len;
}

/* Bodies from the stream, in order, to ON. push throws lsp-error at the first fault in the framing, after giving
   ON every body before it; then and after, push refuses. The same stream gives the same bodies and the same fault
   however it is cut into chunks. */
function decoder(on: (body: string) => void): LspRpcDecoder {
  let head = '';                     // the header block so far (bounded: never past HEADER_MAX + 3)
  let need: number | null = null;    // the body's bytes, once its header is read
  let body: string[] = [], have = 0; // the body so far, joined once it is whole, and its bytes
  let fault: string | null = null;
  const fail = (why: string): never => {
    fault = why; head = ''; body = [];
    throw lspError(`The language server's output breaks its framing: ${why}`);
  };
  function push(chunk: string) {
    if (fault !== null) throw lspError(`The language server's output broke its framing: ${fault}`);
    let rest = String(chunk);
    for (;;) {
      if (need === null) {
        if (!rest) return;
        head += rest; rest = '';
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) { if (head.length > HEADER_MAX + 3) fail(`a header past ${HEADER_MAX} bytes`); return; }
        if (end > HEADER_MAX) fail(`a header past ${HEADER_MAX} bytes`);
        const len = lengthOf(head.slice(0, end));
        if (typeof len === 'string') fail(len);
        rest = head.slice(end + 4); head = '';
        need = len as number; have = 0; body = [];
      }
      /* the body's bytes, counted on from where the last chunk left them */
      let i = 0;
      while (have < need && i < rest.length) have += bytesOf(rest, i, ++i);
      if (have < need) { body.push(rest); return; }
      const last = i > 0 ? rest.charCodeAt(i - 1) : 0;
      if (have > need || (last >= 0xD800 && last <= 0xDBFF)) fail('a Content-Length that ends inside a character');
      body.push(rest.slice(0, i));
      rest = rest.slice(i);
      const text = body.join('');
      need = null; body = [];
      on(text);
    }
  }
  return { push };
}

/* A connection over a transport: WRITE sends framed text to the server (false or a throw: its input is closed). */
function connect(opts: LspRpcOptions): LspRpcConnection {
  const { write, requests = {}, onNotification, onClose } = opts;
  type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: number };
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed: string | null = null;

  const settle = (id: number) => {
    const p = pending.get(id);
    if (!p) return null;
    pending.delete(id);
    if (p.timer !== undefined) clearTimeout(p.timer);
    return p;
  };
  /* MSG framed, or null when it is not JSON (a BigInt, a cycle, a toJSON that throws): only its sender fails,
     the connection goes on. */
  const frame = (msg: unknown) => { try { return encode(msg); } catch (e) { return null; } };
  function send(text: string) {
    if (closed !== null) return;
    let ok = false;
    try { ok = write(text) !== false; } catch (e) { /* its input is full or gone: closed below */ }
    if (!ok) close("The language server's input is closed");
  }
  function close(why?: string) {
    if (closed !== null) return;
    closed = why || 'The language server connection is closed';
    for (const id of [...pending.keys()]) {
      const p = settle(id)!;
      p.reject(lspError(`${p.method}: ${closed}`));
    }
    if (onClose) try { onClose(closed); } catch (e) { Ed.reportError(e); }
  }
  /* The server's answer to a request it sent: RESULT, or an error. */
  function reply(id: unknown, result: unknown, error?: { code: number; message: string }) {
    const text = frame(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: result === undefined ? null : result });
    send(text ?? encode({ jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: 'Edwin answered with a result that is not JSON' } }));
  }

  /* A body the decoder gives after the connection closed (the rest of the chunk it closed in) is dropped. */
  function dispatch(body: string) {
    if (closed !== null) return;
    let msg: unknown;
    try { msg = JSON.parse(body); } catch (e) { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    const hasId = typeof m.id === 'number' || typeof m.id === 'string';
    if (m.method !== undefined) {   // a request or a notification, never a response
      if (typeof m.method !== 'string') return;
      const method = m.method;
      if (!hasId) {
        if (onNotification) try { onNotification(method, m.params); } catch (e) { Ed.reportError(e); }
        return;
      }
      const id = m.id;
      const h = Object.prototype.hasOwnProperty.call(requests, method) ? requests[method] : undefined;
      if (typeof h !== 'function') { reply(id, null, { code: METHOD_NOT_FOUND, message: `Edwin does not handle ${method}` }); return; }
      Promise.resolve().then(() => h(m.params)).then(
        v => reply(id, v),
        e => reply(id, null, { code: INTERNAL_ERROR, message: Ed.errorText(e) }));
      return;
    }
    /* a response: to a request of ours still waiting, else dropped (cancelled, timed out, or never asked) */
    if (typeof m.id !== 'number') return;
    const p = settle(m.id);
    if (!p) return;
    if (m.error != null) {   // "error": null beside a result, which some servers send, is no error
      const err = (m.error && typeof m.error === 'object' ? m.error : {}) as { code?: unknown; message?: unknown };
      const code = typeof err.code === 'number' ? err.code : INTERNAL_ERROR;
      const text = typeof err.message === 'string' ? err.message.slice(0, 500) : 'no message';
      p.reject(lspError(`${p.method}: ${text} (${code})`, code));
    } else p.resolve(m.result === undefined ? null : m.result);
  }

  const dec = decoder(dispatch);
  function receive(chunk: string) {
    if (closed !== null) return;
    try { dec.push(chunk); } catch (e) { close((e as Error).message); }
  }

  function request(method: string, params?: unknown, ropts: { timeout?: number } = {}): LspRpcRequest {
    const id = nextId++;
    const timeout = ropts.timeout === undefined ? DEFAULT_TIMEOUT : ropts.timeout;
    let cancel = () => {};
    const promise = new Promise<unknown>((resolve, reject) => {
      if (closed !== null) { reject(lspError(`${method}: ${closed}`)); return; }
      const text = frame(params == null ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
      if (text === null) { reject(lspError(`${method}: params that are not JSON`)); return; }
      const p: Pending = { method, resolve, reject };
      pending.set(id, p);
      /* rejected here, and the server told it may stop: its late answer is dropped */
      const abandon = (e: unknown) => { if (!settle(id)) return; reject(e); send(encode({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })); };
      cancel = () => abandon(lspError(`${method}: cancelled`));
      if (timeout > 0 && timeout <= TIMEOUT_MAX)
        p.timer = setTimeout(() => abandon(new SchemeError('timeout', `${method}: no answer from the language server in ${timeout / 1000} s`, [])), timeout);
      send(text);
    });
    return Object.assign(promise, { id, cancel: () => cancel() });
  }
  function notify(method: string, params?: unknown) {
    if (closed !== null) throw lspError(`${method}: ${closed}`);
    const text = frame(params == null ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
    if (text === null) throw lspError(`${method}: params that are not JSON`);
    send(text);
  }

  return { receive, request, notify, close, closed: () => closed, pending: () => pending.size };
}

globalThis.LspRpc = { encode, decoder, connect, HEADER_MAX, BODY_MAX, DEFAULT_TIMEOUT };
})();
