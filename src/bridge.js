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

// Transient upstream failures worth one more attempt. Everything else — including
// every other 4xx — is terminal: retrying a 400 or a 401 just wastes the deadline.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

// Sent until `initialize` tells us what the client and server actually negotiated.
// The spec says a server that receives NO version header should assume 2025-03-26,
// so sending a recent version is strictly better than sending nothing.
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/**
 * @typedef {Object} Config
 * @property {string|undefined} apiKey
 * @property {string} baseUrl
 * @property {number} timeoutMs
 * @property {string[]} unknownFlags
 * @property {string|undefined} configError
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
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' && argv[i + 1] !== undefined) apiKey = argv[++i];
    else if (a.startsWith('--key=')) apiKey = a.slice('--key='.length);
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

  return { apiKey, baseUrl, timeoutMs, unknownFlags, configError };
}

/**
 * Validate config. Returns an error message string if invalid, else null.
 * The message never contains the key (there is nothing to leak when it's absent).
 * @param {Config} config
 * @returns {string|null}
 */
export function validateConfig(config) {
  if (config.configError) return config.configError;
  if (config.unknownFlags?.length) {
    return `unknown option ${config.unknownFlags[0]}. Supported: --key, --key=, --key-file`;
  }
  if (!config.apiKey) {
    return 'NUMERATICA_API_KEY is required. Get a free key at https://docs.numeratica.com';
  }
  return null;
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
 * @param {{ apiKey: string }} opts
 * @param {Session} session
 * @returns {Record<string,string>}
 */
function buildHeaders(opts, session) {
  /** @type {Record<string,string>} */
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': session.protocolVersion || FALLBACK_PROTOCOL_VERSION,
  };
  if (session.id) headers['MCP-Session-Id'] = session.id;
  return headers;
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
function retryDelayMs(res, attempt, now) {
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
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
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
 * @param {{ baseUrl: string, apiKey: string, fetch: typeof globalThis.fetch, timeoutMs?: number, session?: Session, now?: () => number }} opts
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

  const timedOut = () =>
    isNotification ? [] : [jsonRpcError(id, -32000, `timed out after ${timeoutMs} ms contacting Numeratica`)];

  const deadline = now() + timeoutMs;
  let res;

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) return timedOut();

    // Bound EVERY request. Without this a connection that opens and goes silent —
    // a slept laptop, a dropped VPN, a load balancer holding the socket — hangs for
    // the OS TCP timeout while the process stays alive holding stdin open, which is
    // the one failure shape no client heuristic detects.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    try {
      res = await opts.fetch(`${opts.baseUrl}/mcp`, {
        method: 'POST',
        headers: buildHeaders(opts, session),
        body,
        signal: ac.signal,
      });
    } catch (err) {
      if (isNotification) return [];
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') return timedOut();
      const detail = err instanceof Error ? err.message : 'unknown error';
      return [jsonRpcError(id, -32000, `transport error contacting Numeratica: ${detail}`)];
    } finally {
      clearTimeout(timer);
    }

    // A server MAY assign a session id at initialization; if it does, the client
    // MUST echo it on every subsequent request or a stateful server answers 400.
    const sid = res?.headers?.get?.('mcp-session-id');
    if (sid) session.id = sid;

    const shouldRetry = RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS;
    if (!shouldRetry) break;

    const wait = retryDelayMs(res, attempt, now());
    if (now() + wait >= deadline) break; // the retry budget must stay inside the timeout
    try {
      await res.body?.cancel?.(); // discard the unread body before reissuing
    } catch {
      // best effort
    }
    await sleep(wait);
  }

  // Notification acks (202/204) carry no body — write nothing.
  if (res.status === 202 || res.status === 204) return [];

  const contentType = res.headers?.get?.('content-type') || '';
  const text = (await res.text()).trim();

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
 * @param {{ baseUrl: string, apiKey: string, fetch: typeof globalThis.fetch }} opts
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
 * @param {{ stdin: NodeJS.ReadableStream, write: (s: string) => void|Promise<void>, fetch: typeof globalThis.fetch, baseUrl: string, apiKey: string, timeoutMs?: number, session?: Session, maxInflight?: number }} opts
 * @returns {Promise<Session>}
 */
export async function run(opts) {
  const session = opts.session ?? {};
  const limit = opts.maxInflight ?? MAX_INFLIGHT;
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
      .catch(() => {
        // A failure here must not reject the drain below and skip the rest.
      })
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

  /** @type {Session} */
  const session = {};
  const opts = {
    stdin: process.stdin,
    write: makeWriter(process.stdout),
    fetch: globalThis.fetch,
    baseUrl: config.baseUrl,
    apiKey: /** @type {string} */ (config.apiKey),
    timeoutMs: config.timeoutMs,
    session,
  };

  // Ending stdin makes run() resolve, which drains in-flight writes and then
  // terminates the session — rather than exiting hard and truncating stdout.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    process.stdin.destroy();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await run(opts);
  await endSession(opts, session);
  process.exitCode = 0;
}
