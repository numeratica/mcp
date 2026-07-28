// Numeratica MCP bridge — a stdio <-> hosted /mcp transport shim.
//
// It is deliberately dumb: it knows nothing about the tool catalog or any
// calculation. Every JSON-RPC message read from stdin is forwarded verbatim to
// the hosted /mcp endpoint and the response is written back to stdout. So
// `initialize`, `tools/list`, and `tools/call` are all answered by the server —
// the bridge auto-syncs with the API and can leak nothing about it.
//
// It is a dumb PIPE, but the thing on either end is a PROTOCOL: it has a session,
// a content-negotiation contract, and concurrent in-flight requests. The request
// body is still forwarded byte-for-byte — that invariant is the whole design — but
// the transport around it now honours those three. Everything the bridge inspects
// (the id, the method, a handful of response headers) is a peek, never a rewrite.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const DEFAULT_BASE_URL = 'https://api.numeratica.com';

// A 60-year Monte Carlo legitimately takes longer than a bracket lookup, so this
// is generous and overridable. What it must never be is absent: Node's fetch has
// no default timeout, so an unbounded request is a permanently wedged bridge.
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;

// Best-effort session teardown on exit must not hold up the process.
const SHUTDOWN_TIMEOUT_MS = 2_000;

// Ceiling on concurrent upstream requests, so a runaway client cannot open
// unbounded sockets. High enough that a normal multi-tool turn never queues.
const MAX_INFLIGHT = 8;

// Methods with no server-side effect, so replaying one after a gateway error is
// free. Everything else is replayed only when the server has told us it did not
// process the request at all (see isRetryable).
const REPLAY_SAFE_METHODS = new Set(['tools/list', 'ping', 'resources/list', 'prompts/list']);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

// JSON-RPC reserves -32000..-32099 for implementation-defined errors. A distinct
// code lets a client separate "you have not configured a key" from "the transport
// failed", which are the same -32000 otherwise and want different remedies.
const MISSING_KEY_CODE = -32001;

// Sent on requests AFTER initialize, until the negotiated version is known. Not on
// initialize itself — see buildHeaders for why "a version beats no version" is
// exactly backwards for that one request.
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/**
 * @typedef {Object} Config
 * @property {string|undefined} apiKey
 * @property {string} baseUrl
 * @property {number} timeoutMs
 * @property {string[]} unknownFlags
 * @property {string|undefined} configError
 * @property {boolean} keyFromArgv
 */

/**
 * @typedef {Object} Session
 * @property {string|undefined} [id]               MCP-Session-Id assigned by the server
 * @property {string|undefined} [protocolVersion]  version negotiated at initialize
 */

/**
 * Resolve configuration from argv and the environment.
 *
 * Accepts `--key <value>`, `--key=<value>` and `--key-file <path>`. The `=` form
 * matters: it is what GNU conventions lead people to type, and matching only the
 * space-separated form meant the key was silently ignored and the user got
 * "NUMERATICA_API_KEY is required" while staring at a command line containing it.
 *
 * @param {string[]} argv  process args (without node/script)
 * @param {Record<string,string|undefined>} env
 * @param {(p: string) => string} [readFile]
 * @returns {Config}
 */
export function loadConfig(argv, env, readFile = (p) => readFileSync(p, 'utf8')) {
  let apiKey = env.NUMERATICA_API_KEY;
  let keyFile;
  let configError;
  let keyFromArgv = false;
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' && argv[i + 1] !== undefined) (apiKey = argv[++i]), (keyFromArgv = true);
    else if (a.startsWith('--key=')) (apiKey = a.slice('--key='.length)), (keyFromArgv = true);
    else if (a === '--key-file' && argv[i + 1] !== undefined) keyFile = argv[++i];
    else if (a.startsWith('--key-file=')) keyFile = a.slice('--key-file='.length);
    else if (a.startsWith('-')) unknownFlags.push(a);
  }

  if (keyFile !== undefined) {
    try {
      apiKey = readFile(keyFile).trim();
    } catch {
      configError = `could not read --key-file ${keyFile}`;
    }
  }

  const baseUrl = (env.NUMERATICA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.NUMERATICA_TIMEOUT_MS;
  if (rawTimeout) {
    const n = Number(rawTimeout);
    if (Number.isFinite(n) && n >= MIN_TIMEOUT_MS) timeoutMs = n;
    else configError = `NUMERATICA_TIMEOUT_MS must be a number >= ${MIN_TIMEOUT_MS} (got ${rawTimeout})`;
  }

  return { apiKey, baseUrl, timeoutMs, unknownFlags, configError, keyFromArgv };
}

/**
 * Validate config. Returns an error message string if invalid, else null.
 * The message never contains the key (there is nothing to leak when it's absent).
 * @param {Config} config
 * @returns {string|null}
 */
export function validateConfig(config) {
  // A --key-file we could not read stays FATAL. The user plainly intended to supply
  // a key; silently demoting that to discovery-only mode would hide a typo'd path
  // behind an integration that lists every tool and refuses to run any of them.
  if (config.configError) return config.configError;
  if (config.unknownFlags?.length) {
    return `unknown option ${config.unknownFlags[0]}. Supported: --key, --key=, --key-file`;
  }
  // A MISSING key is not an error: the bridge starts in discovery-only mode so a
  // client can enumerate the catalogue before anyone signs up. The hosted endpoint
  // already answers initialize/tools/list/ping anonymously; exiting here meant that
  // only crawlers ever saw the benefit and a human evaluating us never did.
  return null;
}

/**
 * True when the bridge is running without a key: discovery works, calls do not.
 * @param {Config} config
 */
export function isDiscoveryOnly(config) {
  return !config.apiKey;
}

/**
 * Build a JSON-RPC 2.0 error response string.
 * @param {number|string|null} id
 * @param {number} code
 * @param {string} message
 * @returns {string}
 */
function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/**
 * Request headers for one upstream call.
 *
 * `Accept` lists BOTH types because the spec requires it ("The client MUST include
 * an Accept header, listing both application/json and text/event-stream"), and a
 * compliant server is entitled to answer 406 otherwise. Sending only
 * application/json worked solely because our own server is lenient.
 *
 * @param {{ apiKey?: string }} opts
 * @param {Session} session
 * @param {string} [method]
 * @returns {Record<string,string>}
 */
function buildHeaders(opts, session, method) {
  /** @type {Record<string,string>} */
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  // OMITTED, not blank: `Bearer ${undefined}` interpolates to the literal string
  // "Bearer undefined", which is a credential-shaped value the server would try to
  // look up and reject — turning "no key" into "bad key" and losing anonymous
  // discovery entirely.
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  // The spec puts MCP-Protocol-Version on requests SUBSEQUENT to initialization.
  // Sending a guess on `initialize` itself is not merely premature, it is worse
  // than sending nothing: a server that speaks only 2025-03-26 must answer 400 for
  // a version it does not support, whereas with no header it is told to ASSUME
  // 2025-03-26 and the handshake succeeds. Once initialize tells us what was
  // actually negotiated, send that on everything.
  if (method !== 'initialize' || session.protocolVersion) {
    headers['MCP-Protocol-Version'] = session.protocolVersion || FALLBACK_PROTOCOL_VERSION;
  }
  if (session.id) headers['MCP-Session-Id'] = session.id;
  return headers;
}

/**
 * Whether an upstream failure is worth another attempt.
 *
 * 429 and 503 mean the server did NOT process the request — replaying is free.
 * 502 and 504 are gateway errors, where the request may well have been delivered
 * and only the response lost: replaying a `tools/call` double-meters the usage
 * event, and replaying `initialize` mints server-side sessions that the extra
 * attempts then orphan — precisely the leak endSession exists to prevent. So
 * those two are replayed only for methods with no server-side effect.
 *
 * @param {number} status
 * @param {string} method
 * @param {number} attempt  1-based
 */
function isRetryable(status, method, attempt) {
  if (attempt >= MAX_ATTEMPTS) return false;
  if (status === 429 || status === 503) return true;
  if (status === 502 || status === 504) return REPLAY_SAFE_METHODS.has(method);
  return false;
}

/**
 * How long to wait before retrying. Honours `Retry-After` (delta-seconds or HTTP
 * date) when the server sent one — 429 is the one status where the server has
 * told you exactly what to do.
 * @param {any} res
 * @param {number} attempt  1-based
 * @param {number} now
 * @returns {number}
 */
export function retryDelayMs(res, attempt, now) {
  const raw = res?.headers?.get?.('retry-after');
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_DELAY_MS);
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) return Math.max(0, Math.min(when - now, MAX_RETRY_DELAY_MS));
  }
  return 400 * 2 ** (attempt - 1); // 400ms, 800ms
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse an SSE body into its `data:` payloads, one per frame.
 *
 * The spec makes SSE the server's option on ANY request, not an opt-in, and the
 * client MUST support both shapes. Without this an SSE body failed JSON.parse and
 * fell through to `oneLine`, which faithfully emitted
 * `event: message data: {...}` to stdout — a line that is not a JSON-RPC message.
 * That failure was silent on this side, which is exactly why it looked fine.
 *
 * Note this parses a completed body rather than streaming incrementally. The
 * hosted endpoint returns a single response per POST, so there is nothing to
 * stream; if it ever emits progress notifications mid-calculation, they would
 * arrive together at the end and this should become an incremental reader.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseSSE(text) {
  const payloads = [];
  // SSE line terminators are CRLF, LF *or* a bare CR — all three are legal. Splitting
  // on /\r?\n/ alone silently yielded zero payloads for a bare-CR stream, which is
  // indistinguishable from "the server said nothing".
  for (const frame of text.split(/(?:\r\n|\r|\n){2}/)) {
    const data = frame
      .split(/\r\n|\r|\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).replace(/^ /, ''))
      .join('\n');
    if (data.trim() !== '') payloads.push(data);
  }
  return payloads;
}

// oneLine collapses any newlines/indentation into single spaces — a fallback for
// non-JSON or unparseable bodies so we never emit a multi-line stdout frame.
/** @param {string} s */
function oneLine(s) {
  return s.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * Truncate by CODE POINT, not UTF-16 code unit. Slicing by code unit can split a
 * surrogate pair — plausible when an upstream error echoes user input containing
 * an emoji — leaving a lone surrogate that JSON.stringify emits as an unpaired
 * escape, which strict parsers reject.
 * @param {string} s
 * @param {number} max
 */
function truncate(s, max) {
  const points = [...s];
  return points.length <= max ? s : points.slice(0, max).join('');
}

/** Collapse an upstream body to exactly one stdout line. @param {string} text */
function compact(text) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return oneLine(text);
  }
}

/**
 * Peek at an `initialize` result to learn the negotiated protocol version. The
 * bridge already parses the request to find the id; parsing this one response
 * field is the same class of peek and it is what lets the hosted API evolve
 * version-conditional behaviour without breaking every installed copy.
 * @param {string} text
 * @param {string} method
 * @param {Session} session
 */
function captureProtocolVersion(text, method, session) {
  if (method !== 'initialize') return;
  try {
    const v = JSON.parse(text)?.result?.protocolVersion;
    if (typeof v === 'string' && v) session.protocolVersion = v;
  } catch {
    // Not our problem — the body is relayed either way.
  }
}

/**
 * Forward one raw JSON-RPC line to the hosted endpoint. Returns the lines to
 * write to stdout — usually one, zero for a notification ack, and more than one
 * only when the server answered with a multi-frame SSE stream.
 *
 * @param {string} line
 * @param {{ baseUrl: string, apiKey?: string, fetch: typeof globalThis.fetch, timeoutMs?: number, session?: Session, now?: () => number }} opts
 * @returns {Promise<string[]>}
 */
export async function forward(line, opts) {
  const body = line.trim();
  if (!body) return [];

  const session = opts.session ?? {};
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());

  // Parse only to learn the id, the method, and whether this is a notification, so
  // we can echo a matching id on error and peek at the initialize result. The body
  // is still forwarded verbatim.
  let id = null;
  let isNotification = false;
  let method = '';
  let isBatch = false;
  try {
    const msg = JSON.parse(body);
    if (Array.isArray(msg)) {
      isBatch = true;
    } else if (msg && typeof msg === 'object') {
      id = msg.id ?? null;
      // A notification is a message with NO id at all. Do NOT "simplify" this to a
      // truthiness check: that would misclassify both `id: 0` and an explicit
      // `id: null`, which is a request and correctly gets an error response.
      isNotification = msg.id === undefined;
      method = typeof msg.method === 'string' ? msg.method : '';
    }
  } catch {
    // Not valid JSON; forward as-is. We just can't echo a matching id on error.
  }

  // Batching was removed in MCP 2025-06-18 — the POST body must be a single
  // request, notification or response. Previously an array fell through and
  // produced an error with a null id by accident; say so on purpose instead.
  if (isBatch) {
    return [jsonRpcError(null, -32600, 'Invalid Request: JSON-RPC batching is not supported; send one message per line')];
  }

  // Short-circuit BEFORE the round trip. The server's own 401 is correct but says
  // nothing about where to get a key — and the person hitting this is the entire
  // reason keyless mode exists: someone evaluating the integration who has just
  // watched 76 tools appear. This message is the one that reaches them, because the
  // model relays a tool error into the conversation, whereas stderr is invisible in
  // most clients.
  if (method === 'tools/call' && !opts.apiKey) {
    if (isNotification) return [];
    return [
      jsonRpcError(
        id,
        MISSING_KEY_CODE,
        'This tool needs a Numeratica API key. Get a free one at ' +
          'https://docs.numeratica.com/get-key, then set NUMERATICA_API_KEY in your MCP ' +
          'client config and restart. Browsing the tool catalogue works without a key; ' +
          'running a calculation does not.',
      ),
    ];
  }

  const timedOut = () =>
    isNotification ? [] : [jsonRpcError(id, -32000, `timed out after ${timeoutMs} ms contacting Numeratica`)];

  const deadline = now() + timeoutMs;
  let res;
  let contentType = '';
  let text = '';

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) return timedOut();

    // Bound EVERY request. Without this a connection that opens and goes silent —
    // a slept laptop, a dropped VPN, a load balancer holding the socket — hangs for
    // the OS TCP timeout while the process stays alive holding stdin open, which is
    // the one failure shape no client heuristic detects.
    //
    // The timer MUST outlive the body read. fetch() settles as soon as response
    // HEADERS arrive, so clearing the timer at that point left res.text() entirely
    // unbounded: a server that sends headers and then stalls the body hung forever
    // despite a stated timeout — the same wedge, one phase later, and the phase a
    // slept laptop actually leaves you in. One controller covers the whole attempt.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    let retryWait = -1;
    try {
      res = await opts.fetch(`${opts.baseUrl}/mcp`, {
        method: 'POST',
        headers: buildHeaders(opts, session, method),
        body,
        signal: ac.signal,
      });

      // A server MAY assign a session id at initialization; if it does, the client
      // MUST echo it on every subsequent request or a stateful server answers 400.
      const sid = res?.headers?.get?.('mcp-session-id');
      if (sid) session.id = sid;

      if (isRetryable(res.status, method, attempt)) {
        const wait = retryDelayMs(res, attempt, now());
        // The retry budget must stay inside the timeout.
        if (now() + wait < deadline) {
          retryWait = wait;
          try {
            await res.body?.cancel?.(); // discard the unread body before reissuing
          } catch {
            // best effort
          }
        }
      }

      // Notification acks (202/204) carry no body — nothing to read.
      if (retryWait < 0 && res.status !== 202 && res.status !== 204) {
        contentType = res.headers?.get?.('content-type') || '';
        text = (await res.text()).trim(); // still under the timer, by design
      }
    } catch (err) {
      if (isNotification) return [];
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') return timedOut();
      const detail = err instanceof Error ? err.message : 'unknown error';
      return [jsonRpcError(id, -32000, `transport error contacting Numeratica: ${detail}`)];
    } finally {
      clearTimeout(timer);
    }

    if (retryWait < 0) break;
    await sleep(retryWait);
  }

  if (res.status === 202 || res.status === 204) return [];

  if (!res.ok) {
    // Per the spec, a 404 on a request carrying a session id means the session
    // expired and the client must re-initialize. Clearing the id is the minimum:
    // the next initialize then starts clean instead of reusing a dead session.
    if (res.status === 404 && session.id) session.id = undefined;
    if (isNotification) return [];
    const detail = text ? `: ${truncate(oneLine(text), 500)}` : '';
    return [jsonRpcError(id, -32000, `Numeratica API error (HTTP ${res.status})${detail}`)];
  }

  if (text === '') return [];

  // MCP's stdio transport frames messages as single-line, newline-delimited JSON
  // (a message MUST NOT contain embedded newlines). The hosted endpoint may
  // pretty-print its JSON, so re-serialize compactly to guarantee one line.
  if (/^text\/event-stream/i.test(contentType)) {
    const payloads = parseSSE(text);
    // A body labelled SSE that yields no data payload — keepalive comments only, or
    // a proxy mislabelling plain JSON. Returning [] strands a request that carried
    // an id: the client waits forever for a response the server did send. That is
    // WORSE than the corrupt frame this branch was added to prevent, because the old
    // code at least emitted something. Treat it as one message.
    if (payloads.length === 0) return isNotification ? [] : [compact(text)];
    for (const p of payloads) captureProtocolVersion(p, method, session);
    return payloads.map(compact);
  }

  captureProtocolVersion(text, method, session);
  return [compact(text)];
}

/**
 * Tell the server the conversation is over. Best effort: failures, and a 405 from
 * a server that does not support explicit termination, are both fine. Without it
 * server-side session state lives until it times out, and `npx` launches a fresh
 * bridge per client restart.
 * @param {{ baseUrl: string, apiKey?: string, fetch: typeof globalThis.fetch }} opts
 * @param {Session} session
 */
export async function endSession(opts, session) {
  if (!session?.id) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SHUTDOWN_TIMEOUT_MS);
  try {
    await opts.fetch(`${opts.baseUrl}/mcp`, {
      method: 'DELETE',
      headers: buildHeaders(opts, session),
      signal: ac.signal,
    });
  } catch {
    // Best effort — we are on the way out.
  } finally {
    clearTimeout(timer);
    session.id = undefined;
  }
}

/**
 * Run the bridge: read newline-delimited JSON-RPC from `stdin`, forward messages
 * concurrently, and write each response with `write`. Resolves on stdin EOF once
 * every in-flight request has been written.
 *
 * Requests are dispatched WITHOUT awaiting the previous one. JSON-RPC permits
 * multiple in-flight requests distinguished by id, and MCP clients use that: a
 * model emitting three tool calls in one turn produces three messages back to
 * back. Awaiting each in turn meant a 40-second Monte Carlo delayed a 50 ms
 * bracket lookup behind it by the full 40 seconds.
 *
 * @param {{ stdin: NodeJS.ReadableStream, write: (s: string) => void|Promise<void>, fetch: typeof globalThis.fetch, baseUrl: string, apiKey?: string, timeoutMs?: number, session?: Session, maxInflight?: number, onError?: (e: unknown) => void }} opts
 * @returns {Promise<Session>}
 */
export async function run(opts) {
  const session = opts.session ?? {};
  // Math.max guards an explicit 0, which ?? would happily accept: `while (0 >= 0)`
  // races an empty Set, i.e. a promise that never settles — a wedge, in the code
  // that exists to prevent wedges.
  const limit = Math.max(1, opts.maxInflight ?? MAX_INFLIGHT);
  const onError = opts.onError ?? ((/** @type {unknown} */ e) => {
    // Swallowing to nothing hides an EPIPE on stdout. stderr is safe: the stdio
    // transport only reserves stdout.
    const msg = e instanceof Error ? e.message : String(e);
    try {
      process.stderr.write(`numeratica-mcp: response write failed: ${msg}\n`);
    } catch {
      // stderr is gone too; there is nowhere left to report.
    }
  });
  const rl = createInterface({ input: opts.stdin, crlfDelay: Infinity });
  /** @type {Set<Promise<void>>} */
  const inflight = new Set();

  for await (const line of rl) {
    while (inflight.size >= limit) await Promise.race(inflight);
    const p = forward(line, { ...opts, session })
      .then(async (lines) => {
        // Sequential within one response so multi-frame SSE keeps its order;
        // across responses order is free, which is what ids are for.
        for (const l of lines) await opts.write(l);
      })
      .catch(onError) // must not reject the drain below — but must not vanish either
      .finally(() => {
        inflight.delete(p);
      });
    inflight.add(p);
  }

  await Promise.allSettled([...inflight]);
  return session;
}

/**
 * Serialized, backpressure-aware writer. `write()` returning false means the
 * kernel buffer is full and the correct move is to wait for 'drain'; ignoring it
 * queues chunks in memory, which is unbounded growth once requests are concurrent
 * and the client reads slowly.
 * @param {NodeJS.WritableStream} stream
 */
export function makeWriter(stream) {
  let queue = Promise.resolve();
  return (/** @type {string} */ s) => {
    const line = s.endsWith('\n') ? s : s + '\n';
    queue = queue.then(
      () =>
        new Promise((resolve) => {
          if (stream.write(line)) resolve();
          else stream.once('drain', () => resolve());
        }),
    );
    return queue;
  };
}

/** CLI entrypoint: wire process stdio + global fetch, or exit cleanly on misconfig. */
export async function main() {
  const config = loadConfig(process.argv.slice(2), process.env);
  const err = validateConfig(config);
  if (err) {
    process.stderr.write(`numeratica-mcp: ${err}\n`);
    // NOT process.exit(): stdout is async when it is a pipe (always, under an MCP
    // client) and exit() tears the process down without flushing pending writes.
    process.exitCode = 1;
    return;
  }

  // Discovery-only mode is a real, useful state — but an integration that lists 76
  // tools and fails every call reads as broken unless it says otherwise. Say it
  // plainly, and say what to do. (stderr is safe: the stdio transport reserves only
  // stdout, so no client parses this as protocol.)
  if (isDiscoveryOnly(config)) {
    process.stderr.write(
      'numeratica-mcp: no API key set — running in DISCOVERY-ONLY mode. ' +
        'Tool listing works; running a calculation does not. ' +
        'Set NUMERATICA_API_KEY (free key: https://docs.numeratica.com/get-key) to enable calls.\n',
    );
  }

  // The README documents the hazard, but a warning where it actually happens is
  // what reaches someone who copied a config from a blog post: a key in argv is
  // readable by `ps` for every user on the box and lands in shell history.
  if (config.keyFromArgv) {
    process.stderr.write(
      'numeratica-mcp: warning: --key exposes your API key in the process list; prefer NUMERATICA_API_KEY or --key-file\n',
    );
  }

  /** @type {Session} */
  const session = {};
  const opts = {
    stdin: process.stdin,
    write: makeWriter(process.stdout),
    fetch: globalThis.fetch,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    session,
  };

  // Ending stdin makes run() resolve, which drains in-flight writes and then
  // terminates the session — rather than exiting hard and truncating stdout.
  //
  // push(null), NOT destroy(): destroy() emits 'close', not 'end', and a readline
  // async iterator does not terminate on close. So the loop never ended, run()
  // never resolved, and the DELETE never fired — while registering this handler at
  // all suppressed Node's default SIGINT termination, so Ctrl-C hung a process
  // that used to exit. push(null) ends the stream the way the iterator expects.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    process.stdin.push(null);
    // A wedged upstream must not hold the exit past the shutdown budget. unref'd so
    // it never keeps an otherwise-idle process alive.
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await run(opts);
  await endSession(opts, session);
  process.exitCode = 0;
}
