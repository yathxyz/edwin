# The hub protocol, version 1

edwind never starts a process (R4.45). A *hub* does it on edwind's behalf: a process server on a Unix socket
that runs PTYs and keeps them across client disconnects. edit.json names the socket with `hubSocket`; with none,
edwind has no hub and process primitives raise `hub-error`. This file is the protocol between them; edwind is the
client (`server/hub.mts`, `server/process.mts`), and `test/fake-hub.mts` is a reference server for the suites.
Workbench's wb-hub serves it on `/run/workbench-hub/hub.sock`.

## Framing

One JSON object per line (NDJSON, UTF-8), each with a type `t`. A line is at most 16 MiB (`MAX_LINE`); edwind
closes a connection that sends a longer one. edwind ignores fields and message types it does not know, and sends
only the fields below.

## Hello

1. On connect the server sends its hello first:
   `{"t":"hello","proto":1,"version":"…","host":"…","pid":N,"startedAt":MS,"shells":["bash",…],"defaultShell":"bash"}`
   (`build` optional; anything else is ignored).
2. The client answers within 5 s (`HELLO_TIMEOUT`): `{"t":"hello","proto":1,"client":"edwind/<build>"}`.

A `proto` other than 1 on either side ends the connection: the server may first send `err` with code `proto`, and
edwind reports the hub as `incompatible` and retries at the longest backoff.

## Requests and replies

A request carries a nonzero integer `rid`, unique on its connection, and gets exactly one reply with that `rid`:
`{"t":"ok","rid":N,…}` with the fields below, or `{"t":"err","rid":N,"code":"…","message":"…"}`. edwind gives
up on a reply after 10 s (a kill: 30 s) and reports `timeout`. `pty.input` has no reply.

| Request | Fields | `ok` fields |
| --- | --- | --- |
| `watch` | | `sessions`: every Summary; afterwards the connection receives `session` and `gone` |
| `list` | | `sessions`: every Summary |
| `pty.open` (spawn) | `sid`, `cols`, `rows`, `spawn`: `{argv, shell, cwd?, env?}` | `new`, `pid?`, `cwd`, `exit?`, `epoch`, `stream`, `out`, `resumed: false` |
| `pty.open` (attach) | `sid`, `cols`, `rows`, `resume?`: `{stream, out}` | as above, with `resumed` and `replay?` |
| `pty.input` | `sid`, `d`: at most 1 MiB of UTF-8 (`PTY_INPUT_FRAME`) | no reply |
| `pty.kill` | `sid`, `forget` | after the process exited; with `forget` the session is removed and `gone` follows |

- **`sid`** is chosen by the client: 1 to 64 of `[A-Za-z0-9_-]`. edwind's are `ed-` and 16 base32 characters, so a
  hub that shows its sessions can tell edwind's apart.
- **`spawn`**: `shell` is one of the hello's `shells`; `argv` is `[shell]` for an interactive shell or
  `[shell, "-c", command]`; `env` has at most 32 entries. A refused spawn is `err` (edwind: `process-error` with
  the server's message). The server sets `TERM` itself, which is why `call-process` prefixes
  `export TERM=dumb NO_COLOR=1; ` for POSIX shells.
- **Attach**: `pty.open` without `spawn`, or for a live session, attaches the connection to an existing session.
  With `resume` matching the session's `stream` and an `out` no later than its byte count, `resumed` is true and
  `replay` is the output after `out`; otherwise `replay` is a snapshot. edwind re-attaches its processes with
  `resume` after every reconnect.
- **Errors**: `not_found` on `pty.kill` means the session is already gone; any `err` on a spawn is the server's
  refusal.

## Events

| Event | Fields | To |
| --- | --- | --- |
| `session` | `session`: a Summary | watching connections, on every change |
| `gone` | `sid`, `epoch` | watching connections, when a session is forgotten |
| `pty.out` | `sid`, `d`, `out` (the byte count after `d`) | connections attached to `sid` |
| `pty.exit` | `sid`, `code`, `signal`, `reason` | connections attached to `sid` |
| `pty.fg` | `sid`, … | attached connections; edwind ignores it |

edwind knows the `reason`s `exited`, `killed`, `spawn_failed` and `hub_restart`.

## Summary

`{"sid","kind","host","createdAt","updatedAt","alive","viewers","cwd","fault","pty"?}`. `kind` is `pty` for a PTY,
and edwind ignores sessions of any other kind. `createdAt` is the session's epoch (`gone` names it). `pty` is
`{argv, pid?, fg?: {comm, pgid, leader}, exit?: {code, signal, reason, at?}}`. `fault` is `{code, message}` or
null.

## Connection policy (edwind's)

Connect timeout 2 s; reconnect with a backoff from 250 ms doubling to 5 s, ±25 % jitter, reset after 5 s up. While
the hub is down, `hub-status` is `down`, requests fail with `hub-error`, and processes keep their last known
state until the re-attach.
