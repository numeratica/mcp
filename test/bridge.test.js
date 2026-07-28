import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  forward, run, loadConfig, validateConfig, isDiscoveryOnly,
  parseSSE, endSession, makeWriter, retryDelayMs,
} from '../src/bridge.js';

/**
 * Minimal stand-in for a fetch Response.
 * `headers` is real: without it the session-id and protocol-version round trips
 * are invisible to the suite, which is precisely how they went missing.
 *
 * Cast rather than a full Response: only the handful of members `forward` touches
 * are modelled, and a faithful Response would obscure which ones those are.
 * @returns {Response}
 */
function mockResponse({ status = 200, body = '', headers = {} } = {}) {
  return /** @type {any} */ ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => body,
    body: { cancel: async () => {} },
  });
}

const BASE = { baseUrl: 'https://api.example.com', apiKey: 'sek_test' };

// --- forwarding basics -------------------------------------------------------

test('forwards a tools/call to /mcp with the Bearer header and returns the response', async () => {
  let seenUrl = /** @type {any} */ (null);
  let seenInit = /** @type {any} */ (null);
  const fetchMock = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return mockResponse({ body: '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}' });
  };
  const req = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"tvm"}}';
  const out = await forward(req, { ...BASE, fetch: fetchMock });

  assert.equal(seenUrl, 'https://api.example.com/mcp');
  assert.equal(seenInit.method, 'POST');
  assert.equal(seenInit.headers.Authorization, 'Bearer sek_test');
  assert.equal(seenInit.headers['Content-Type'], 'application/json');
  assert.equal(seenInit.body, req); // forwarded verbatim
  assert.equal(out.length, 1);
  assert.match(out[0], /"id":7/);
});

test('Accept lists both application/json and text/event-stream', async () => {
  // The spec: "The client MUST include an Accept header, listing both
  // application/json and text/event-stream". A compliant server may answer 406
  // otherwise; sending only application/json worked because ours is lenient.
  let seen = /** @type {any} */ (null);
  const fetchMock = async (_url, init) => {
    seen = init.headers.Accept;
    return mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
  };
  await forward('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', { ...BASE, fetch: fetchMock });
  assert.match(seen, /application\/json/);
  assert.match(seen, /text\/event-stream/);
});

test('a notification (no id, 202 ack) yields no stdout', async () => {
  let called = false;
  const fetchMock = async () => {
    called = true;
    return mockResponse({ status: 202 });
  };
  const out = await forward('{"jsonrpc":"2.0","method":"notifications/initialized"}', { ...BASE, fetch: fetchMock });
  assert.equal(called, true); // it IS forwarded...
  assert.deepEqual(out, []); // ...but produces no output
});

test('a 204 response yields no stdout', async () => {
  const fetchMock = async () => mockResponse({ status: 204 });
  const out = await forward('{"jsonrpc":"2.0","id":1,"method":"ping"}', { ...BASE, fetch: fetchMock });
  assert.deepEqual(out, []);
});

test('a non-2xx response is relayed as a JSON-RPC error carrying the request id', async () => {
  const fetchMock = async () => mockResponse({ status: 401, body: '{"error":{"code":"unauthorized"}}' });
  const out = await forward('{"jsonrpc":"2.0","id":3,"method":"tools/list"}', { ...BASE, fetch: fetchMock });
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.id, 3);
  assert.ok(parsed.error);
  assert.match(parsed.error.message, /401/);
});

test('a pretty-printed (multi-line) upstream response is compacted to a single stdout line', async () => {
  // The hosted /mcp endpoint pretty-prints JSON; MCP stdio framing forbids embedded
  // newlines, so the bridge must collapse it to one line.
  const pretty = '{\n  "jsonrpc": "2.0",\n  "id": 9,\n  "result": { "ok": true }\n}';
  const fetchMock = async () => mockResponse({ body: pretty });
  const out = await forward('{"jsonrpc":"2.0","id":9,"method":"tools/list"}', { ...BASE, fetch: fetchMock });
  assert.ok(!out[0].includes('\n'), 'output must not contain a newline');
  assert.deepEqual(JSON.parse(out[0]), { jsonrpc: '2.0', id: 9, result: { ok: true } });
});

test('an unparseable body still cannot emit a multi-line frame', async () => {
  const fetchMock = async () => mockResponse({ body: '<html>\n  <body>502</body>\n</html>' });
  const out = await forward('{"jsonrpc":"2.0","id":1,"method":"ping"}', { ...BASE, fetch: fetchMock });
  assert.equal(out.length, 1);
  assert.ok(!out[0].includes('\n'));
});

// --- concurrency, timeouts, retries -----------------------------------------

test('two requests are in flight at once — a slow call does not block a fast one', async () => {
  // The whole point of JSON-RPC ids. Serially, request 2 could not even be READ
  // until request 1's round trip finished.
  let active = 0;
  let maxActive = 0;
  const fetchMock = async (_url, init) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const id = JSON.parse(init.body).id;
    await new Promise((r) => setTimeout(r, id === 1 ? 60 : 5));
    active--;
    return mockResponse({ body: `{"jsonrpc":"2.0","id":${id},"result":{}}` });
  };
  const writes = [];
  const stdin = Readable.from([
    '{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call"}\n',
  ]);
  await run({ stdin, write: (s) => void writes.push(s), fetch: fetchMock, ...BASE });

  assert.equal(maxActive, 2, 'both requests should be in flight together');
  assert.equal(writes.length, 2);
  // The fast one finishes first, proving it was not queued behind the slow one.
  assert.match(writes[0], /"id":2/);
});

test('maxInflight caps concurrent upstream requests', async () => {
  let active = 0;
  let maxActive = 0;
  const fetchMock = async (_url, init) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return mockResponse({ body: `{"jsonrpc":"2.0","id":${JSON.parse(init.body).id},"result":{}}` });
  };
  const lines = Array.from({ length: 8 }, (_, i) => `{"jsonrpc":"2.0","id":${i},"method":"ping"}`).join('\n');
  const writes = [];
  await run({ stdin: Readable.from([lines + '\n']), write: (s) => void writes.push(s), fetch: fetchMock, ...BASE, maxInflight: 2 });
  assert.equal(writes.length, 8);
  assert.equal(maxActive, 2, 'must reach the cap exactly — <= 2 also passes when serial');
});

test('a hung request times out as a JSON-RPC error instead of wedging forever', async () => {
  // Without a signal this await never settles, the process stays alive holding
  // stdin open, and no client heuristic detects it.
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  const out = await forward('{"jsonrpc":"2.0","id":5,"method":"tools/call"}', {
    ...BASE,
    fetch: hangingFetch,
    timeoutMs: 1000,
  });
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.id, 5);
  assert.match(parsed.error.message, /timed out/i);
});

test('a hung notification times out silently (no stdout frame)', async () => {
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  const out = await forward('{"jsonrpc":"2.0","method":"notifications/initialized"}', {
    ...BASE,
    fetch: hangingFetch,
    timeoutMs: 1000,
  });
  assert.deepEqual(out, []);
});

test('a 429 is retried, honouring Retry-After, and the eventual success is returned', async () => {
  let attempts = 0;
  const fetchMock = async () => {
    attempts++;
    if (attempts < 3) return mockResponse({ status: 429, headers: { 'retry-after': '0' }, body: 'slow down' });
    return mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' });
  };
  const out = await forward('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', { ...BASE, fetch: fetchMock });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(out[0]).result, { ok: true });
});

test('a 400 is NOT retried — only transient statuses are', async () => {
  let attempts = 0;
  const fetchMock = async () => {
    attempts++;
    return mockResponse({ status: 400, body: '{"error":"bad"}' });
  };
  await forward('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', { ...BASE, fetch: fetchMock });
  assert.equal(attempts, 1);
});

test('the retry budget stays inside the request timeout', async () => {
  // A retry that would land past the deadline must not be attempted.
  let attempts = 0;
  const fetchMock = async () => {
    attempts++;
    return mockResponse({ status: 503, headers: { 'retry-after': '60' } });
  };
  const out = await forward('{"jsonrpc":"2.0","id":1,"method":"ping"}', { ...BASE, fetch: fetchMock, timeoutMs: 2000 });
  assert.equal(attempts, 1, 'a 60s Retry-After exceeds a 2s budget, so no retry');
  assert.match(JSON.parse(out[0]).error.message, /503/);
});

// --- session + protocol version ---------------------------------------------

test('MCP-Session-Id is captured at initialize and echoed on later requests', async () => {
  const seen = [];
  const fetchMock = async (_url, init) => {
    seen.push(init.headers['MCP-Session-Id']);
    return mockResponse({
      headers: { 'mcp-session-id': 'sess-abc' },
      body: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25"}}',
    });
  };
  const session = {};
  await forward('{"jsonrpc":"2.0","id":1,"method":"initialize"}', { ...BASE, fetch: fetchMock, session });
  assert.equal(session.id, 'sess-abc');
  await forward('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', { ...BASE, fetch: fetchMock, session });

  assert.equal(seen[0], undefined, 'nothing to echo on the first request');
  assert.equal(seen[1], 'sess-abc', 'the id must ride on every subsequent request');
});

test('the negotiated protocolVersion is captured and sent on later requests', async () => {
  const seen = [];
  const fetchMock = async (_url, init) => {
    seen.push(init.headers['MCP-Protocol-Version']);
    return mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25"}}' });
  };
  const session = {};
  await forward('{"jsonrpc":"2.0","id":1,"method":"initialize"}', { ...BASE, fetch: fetchMock, session });
  await forward('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', { ...BASE, fetch: fetchMock, session });

  assert.equal(seen[0], undefined, 'no version guess on initialize itself');
  assert.equal(seen[1], '2025-11-25', 'after initialize, send what was negotiated');
});

test('a 404 carrying a session id clears it so the next initialize starts clean', async () => {
  const session = { id: 'stale' };
  const fetchMock = async () => mockResponse({ status: 404, body: 'session expired' });
  await forward('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', { ...BASE, fetch: fetchMock, session });
  assert.equal(session.id, undefined);
});

test('endSession DELETEs with the session id, and is a no-op without one', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, method: init.method, sid: init.headers['MCP-Session-Id'] });
    return mockResponse({ status: 204 });
  };
  await endSession({ ...BASE, fetch: fetchMock }, {});
  assert.equal(calls.length, 0, 'no session, nothing to terminate');

  const session = { id: 'sess-xyz' };
  await endSession({ ...BASE, fetch: fetchMock }, session);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].sid, 'sess-xyz');
  assert.equal(session.id, undefined);
});

test('endSession swallows a failure — shutdown must not throw', async () => {
  const fetchMock = async () => {
    throw new Error('connection refused');
  };
  await endSession({ ...BASE, fetch: fetchMock }, { id: 'sess-1' }); // must not reject
});

// --- SSE ---------------------------------------------------------------------

test('parseSSE extracts one payload per frame and ignores comments and other fields', () => {
  const body = ': keep-alive\nevent: message\ndata: {"a":1}\n\nevent: message\ndata: {"b":2}\n\n';
  assert.deepEqual(parseSSE(body), ['{"a":1}', '{"b":2}']);
});

test('an SSE response becomes one JSON line per frame, not a corrupt frame', async () => {
  // Previously this failed JSON.parse and fell through to oneLine, which emitted
  // `event: message data: {...}` — a line that is not a JSON-RPC message.
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"step":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"step":2}}\n\n';
  const fetchMock = async () => mockResponse({ body: sse, headers: { 'content-type': 'text/event-stream' } });
  const out = await forward('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', { ...BASE, fetch: fetchMock });

  assert.equal(out.length, 2);
  for (const line of out) {
    assert.ok(!line.includes('\n'));
    assert.ok(!line.startsWith('event:'), 'must not leak the SSE envelope to stdout');
    assert.equal(JSON.parse(line).jsonrpc, '2.0');
  }
});

test('a multi-frame SSE response keeps its order through run()', async () => {
  const sse = 'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"n":2}}\n\n';
  const fetchMock = async () => mockResponse({ body: sse, headers: { 'content-type': 'text/event-stream' } });
  const writes = [];
  await run({
    stdin: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n']),
    write: (s) => void writes.push(s),
    fetch: fetchMock,
    ...BASE,
  });
  assert.deepEqual(writes.map((w) => JSON.parse(w).result.n), [1, 2]);
});

// --- framing, batching, truncation -------------------------------------------

test('a JSON-RPC batch is rejected explicitly rather than by accident', async () => {
  let called = false;
  const fetchMock = async () => {
    called = true;
    return mockResponse({});
  };
  const out = await forward('[{"jsonrpc":"2.0","id":1,"method":"ping"}]', { ...BASE, fetch: fetchMock });
  assert.equal(called, false, 'no point forwarding what the spec removed');
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.error.code, -32600);
  assert.match(parsed.error.message, /batching is not supported/);
});

test('an error body is truncated on code points, never splitting a surrogate pair', async () => {
  // Slicing by UTF-16 code unit can leave a lone surrogate, which JSON.stringify
  // emits as an unpaired escape that strict parsers reject.
  // The leading 'a' matters: each emoji is TWO code units, so without it a cut at
  // 500 lands exactly on a pair boundary and never splits one. Offsetting by one
  // puts the boundary mid-pair, which is the case being defended against.
  const body = 'a' + '🎯'.repeat(600);
  const fetchMock = async () => mockResponse({ status: 500, body });
  const out = await forward('{"jsonrpc":"2.0","id":1,"method":"ping"}', { ...BASE, fetch: fetchMock });

  const message = JSON.parse(out[0]).error.message;
  const withoutPairs = message.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
  assert.ok(!/[\uD800-\uDFFF]/.test(withoutPairs), 'a lone surrogate survived truncation');
  assert.ok(message.length > 100, 'sanity: truncation actually happened here');
});

test('id: 0 and an explicit id: null are requests, not notifications', async () => {
  const fetchMock = async () => mockResponse({ status: 500, body: 'boom' });
  const zero = await forward('{"jsonrpc":"2.0","id":0,"method":"ping"}', { ...BASE, fetch: fetchMock });
  assert.equal(JSON.parse(zero[0]).id, 0, 'id 0 is falsy but is a real id');
  const nul = await forward('{"jsonrpc":"2.0","id":null,"method":"ping"}', { ...BASE, fetch: fetchMock });
  assert.equal(JSON.parse(nul[0]).id, null);
});

// --- writer ------------------------------------------------------------------

test('makeWriter waits for drain before the next write, and preserves order', async () => {
  // Ignoring write()'s false return queues chunks in memory — unbounded growth
  // once requests are concurrent and the client reads slowly.
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const realWrite = stream.write.bind(stream);
  let drainedBeforeSecond = false;
  let first = true;
  stream.write = (s) => {
    if (!first) drainedBeforeSecond = true;
    realWrite(s);
    if (first) {
      first = false;
      setTimeout(() => stream.emit('drain'), 5); // buffer frees up later
      return false; // ...but report "full" now
    }
    return true;
  };
  const write = makeWriter(stream);
  const both = Promise.all([write('one'), write('two')]);
  // Let the queued first write run, but not the 5ms drain timer.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(chunks, ['one\n'], 'the second write must not start before drain');
  await both;
  assert.equal(drainedBeforeSecond, true);
  assert.deepEqual(chunks, ['one\n', 'two\n']);
});

test('makeWriter appends a newline only when absent', async () => {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const write = makeWriter(stream);
  await write('a');
  await write('b\n');
  assert.deepEqual(chunks, ['a\n', 'b\n']);
});

// --- config ------------------------------------------------------------------

test('loadConfig: --key overrides env, default base url, trailing slash trimmed', () => {
  assert.equal(loadConfig([], {}).baseUrl, 'https://api.numeratica.com');
  const cfg = loadConfig(['--key', 'flagkey'], { NUMERATICA_API_KEY: 'envkey', NUMERATICA_BASE_URL: 'https://h.test/' });
  assert.equal(cfg.apiKey, 'flagkey');
  assert.equal(cfg.baseUrl, 'https://h.test');
});

test('loadConfig: --key=value is honoured, not silently ignored', () => {
  // The form GNU conventions lead people to type. It used to fall through to the
  // env var, producing "NUMERATICA_API_KEY is required" while the key was right
  // there on the command line.
  assert.equal(loadConfig(['--key=inline'], {}).apiKey, 'inline');
});

test('loadConfig: --key-file reads and trims the key', () => {
  const cfg = loadConfig(['--key-file', '/tmp/k'], {}, () => 'filekey\n');
  assert.equal(cfg.apiKey, 'filekey');
  assert.equal(validateConfig(cfg), null);
});

test('loadConfig: an unreadable --key-file is a clear error, not a missing key', () => {
  const cfg = loadConfig(['--key-file', '/nope'], { NUMERATICA_API_KEY: 'env' }, () => {
    throw new Error('ENOENT');
  });
  assert.match(validateConfig(cfg) ?? '', /could not read --key-file/);
});

test('loadConfig: an unknown flag is rejected rather than ignored', () => {
  const cfg = loadConfig(['--kye', 'typo'], { NUMERATICA_API_KEY: 'env' });
  assert.match(validateConfig(cfg) ?? '', /unknown option --kye/);
});

test('loadConfig: NUMERATICA_TIMEOUT_MS is honoured and validated', () => {
  assert.equal(loadConfig([], { NUMERATICA_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
  const bad = loadConfig([], { NUMERATICA_API_KEY: 'k', NUMERATICA_TIMEOUT_MS: 'soon' });
  assert.match(validateConfig(bad) ?? '', /NUMERATICA_TIMEOUT_MS/);
});

test('a missing key is NOT a config error — it selects discovery-only mode', () => {
  const cfg = loadConfig([], {});
  assert.equal(validateConfig(cfg), null, 'the bridge must start so the catalogue can be browsed');
  assert.equal(isDiscoveryOnly(cfg), true);
  assert.equal(isDiscoveryOnly(loadConfig([], { NUMERATICA_API_KEY: 'k' })), false);
});

test('the bin starts without a key and says what mode it is in', () => {
  const bin = fileURLToPath(new URL('../bin/numeratica-mcp.js', import.meta.url));
  const r = spawnSync(process.execPath, [bin], {
    env: { PATH: process.env.PATH }, // no NUMERATICA_API_KEY
    input: '', // immediate EOF
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'no key is a supported mode, not a failure');
  assert.equal(r.stdout, '', 'stdout carries protocol only — never diagnostics');
  assert.match(r.stderr, /DISCOVERY-ONLY/);
  assert.match(r.stderr, /NUMERATICA_API_KEY/, 'say which variable to set');
  assert.match(r.stderr, /docs\.numeratica\.com/, 'say where to get a key');
});

test('every OTHER config error is still fatal', () => {
  const bin = fileURLToPath(new URL('../bin/numeratica-mcp.js', import.meta.url));
  const runBin = (args, env) =>
    spawnSync(process.execPath, [bin, ...args], {
      env: { PATH: process.env.PATH, ...env },
      input: '',
      encoding: 'utf8',
    });

  // An unreadable --key-file is the important one: the user plainly MEANT to supply
  // a key, so quietly dropping to discovery-only would hide a typo'd path behind an
  // integration that lists every tool and runs none of them.
  const keyFile = runBin(['--key-file', '/definitely/not/here'], {});
  assert.equal(keyFile.status, 1, 'a key-file that cannot be read must not degrade to keyless');
  assert.match(keyFile.stderr, /could not read --key-file/);
  assert.equal(keyFile.stdout, '');

  assert.equal(runBin(['--kye', 'typo'], {}).status, 1, 'unknown flag');
  assert.equal(runBin([], { NUMERATICA_TIMEOUT_MS: 'soon' }).status, 1, 'unparseable timeout');
});

test('a large final response survives shutdown intact (writer drain, end to end)', () => {
  // NAMED HONESTLY, second time around. This was called a process.exit() test, but it
  // passes with process.exit(0) restored — because makeWriter already awaits 'drain'
  // before run() resolves, so nothing is ever pending by the time exit is reached.
  // What it actually proves is the backpressure-aware writer, end to end.
  //
  // exitCode is still the right call (it costs nothing and does not depend on the
  // writer staying correct), but it is defence in depth here, not the load-bearing
  // guarantee — and a test that cannot fail is worse than no test, because it makes
  // a revert-check look thorough when it isn't.
  const src = fileURLToPath(new URL('../src/bridge.js', import.meta.url));
  const script = `
    globalThis.fetch = async () => ({
      status: 200, ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { big: 'x'.repeat(200000) } }),
      body: { cancel: async () => {} },
    });
    const { main } = await import(${JSON.stringify(src)});
    await main();
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n',
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NUMERATICA_API_KEY: 'k' },
  });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim();
  assert.equal(JSON.parse(line).result.big.length, 200_000, 'the full response must survive exit');
});

// --- second-round findings ---------------------------------------------------

test('a stalled response BODY times out — not just a stalled connection', async () => {
  // fetch() settles when HEADERS arrive. Clearing the abort timer there left
  // res.text() unbounded, so a server that answers headers and then stops sending
  // hung forever at a stated timeout. Both earlier timeout tests used a fetch that
  // never resolved at all, so neither could see this.
  const stalledBody = (_url, init) =>
    /** @type {any} */ (Promise.resolve({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { cancel: async () => {} },
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    }));
  // Raced, not just timed: if the fix regresses, forward() never settles at all, and
  // a test that hangs forever is useless in CI — it must FAIL, and quickly.
  const out = await Promise.race([
    forward('{"jsonrpc":"2.0","id":4,"method":"tools/call"}', { ...BASE, fetch: stalledBody, timeoutMs: 1000 }),
    new Promise((resolve) => setTimeout(() => resolve(['HUNG']), 4000)),
  ]);
  assert.notEqual(out[0], 'HUNG', 'the body read outlived the request timeout');
  assert.match(JSON.parse(out[0]).error.message, /timed out/i);
});

test('retryDelayMs honours Retry-After seconds, an HTTP date, and falls back to backoff', () => {
  // The previous retry test asserted nothing about the delay: deleting the whole
  // Retry-After branch left it passing, just slower.
  const withHeader = (h) => ({ headers: new Headers(h) });
  const now = 1_000_000;
  assert.equal(retryDelayMs(withHeader({ 'retry-after': '2' }), 1, now), 2000);
  assert.equal(retryDelayMs(withHeader({ 'retry-after': '0' }), 1, now), 0);
  // HTTP-date form — the branch nothing covered. opts.now is the seam that makes it
  // deterministic.
  const when = new Date(now + 5000).toUTCString();
  const fromDate = retryDelayMs(withHeader({ 'retry-after': when }), 1, now);
  assert.ok(Math.abs(fromDate - 5000) < 1000, `expected ~5000ms, got ${fromDate}`);
  // Absent header: exponential backoff.
  assert.equal(retryDelayMs(withHeader({}), 1, now), 400);
  assert.equal(retryDelayMs(withHeader({}), 2, now), 800);
  // Absurd values are capped.
  assert.equal(retryDelayMs(withHeader({ 'retry-after': '99999' }), 1, now), 30_000);
});

test('a 502 replays tools/list but NOT tools/call', async () => {
  // A gateway error may mean the request WAS delivered. Replaying a tools/call
  // triple-meters the usage event; replaying initialize orphans sessions.
  const attemptsFor = async (method) => {
    let n = 0;
    const fetchMock = async () => {
      n++;
      return mockResponse({ status: 502, body: 'bad gateway' });
    };
    await forward(`{"jsonrpc":"2.0","id":1,"method":"${method}"}`, { ...BASE, fetch: fetchMock });
    return n;
  };
  assert.equal(await attemptsFor('tools/list'), 3, 'read-only, safe to replay');
  assert.equal(await attemptsFor('tools/call'), 1, 'side-effecting, must not be replayed');
  assert.equal(await attemptsFor('initialize'), 1, 'would orphan server-side sessions');
});

test('a 429 replays even a tools/call — nothing was executed', async () => {
  let n = 0;
  const fetchMock = async () => {
    n++;
    return n < 2
      ? mockResponse({ status: 429, headers: { 'retry-after': '0' } })
      : mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
  };
  await forward('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', { ...BASE, fetch: fetchMock });
  assert.equal(n, 2);
});

test('an SSE body with no data payload still answers a request that carried an id', async () => {
  // Returning [] here strands the caller forever — worse than the corrupt frame the
  // SSE branch was added to prevent, because the old code at least emitted something.
  const cases = [
    ': keep-alive\n\n: keep-alive\n\n', // comments only
    '{"jsonrpc":"2.0","id":1,"result":{}}', // a proxy mislabelling plain JSON as SSE
  ];
  for (const body of cases) {
    const fetchMock = async () => mockResponse({ body, headers: { 'content-type': 'text/event-stream' } });
    const out = await forward('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', { ...BASE, fetch: fetchMock });
    assert.equal(out.length, 1, `expected a frame for body ${JSON.stringify(body)}`);
    assert.ok(!out[0].includes('\n'));
  }
});

test('parseSSE handles bare-CR terminators, which are legal SSE', () => {
  assert.deepEqual(parseSSE('event: message\rdata: {"a":1}\r\r'), ['{"a":1}']);
  assert.deepEqual(parseSSE('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'), ['{"a":1}', '{"b":2}']);
});

test('the negotiated protocol version is captured from an SSE initialize too', async () => {
  // The SSE capture path was correct in code but no test used initialize over SSE,
  // so deleting it changed nothing.
  const fetchMock = async () =>
    mockResponse({
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25"}}\n\n',
    });
  const session = {};
  await forward('{"jsonrpc":"2.0","id":1,"method":"initialize"}', { ...BASE, fetch: fetchMock, session });
  assert.equal(session.protocolVersion, '2025-11-25');
});

test('maxInflight: 0 does not wedge the loop', async () => {
  // `?? MAX_INFLIGHT` accepts an explicit 0, and `while (0 >= 0) await race(empty)`
  // never settles — a wedge inside the wedge-prevention code.
  const fetchMock = async () => mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
  const writes = [];
  await run({
    stdin: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']),
    write: (s) => void writes.push(s),
    fetch: fetchMock,
    ...BASE,
    maxInflight: 0,
  });
  assert.equal(writes.length, 1);
});

test('a write failure is surfaced, not swallowed', async () => {
  const seen = [];
  const fetchMock = async () => mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
  await run({
    stdin: Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']),
    write: () => {
      throw new Error('EPIPE');
    },
    onError: (e) => seen.push(e),
    fetch: fetchMock,
    ...BASE,
  });
  assert.equal(seen.length, 1, 'an EPIPE on stdout must not vanish');
  assert.match(String(seen[0].message ?? seen[0]), /EPIPE/);
});

test('SIGINT ends the session and exits — it must not hang', async () => {
  // stdin.destroy() emits 'close', not 'end', and a readline async iterator does not
  // terminate on close: run() never resolved, so the DELETE never fired — and
  // registering the handler at all suppressed Node's default SIGINT exit, so Ctrl-C
  // hung a process that used to die. No test covered the signal path, which is how
  // it shipped.
  const src = fileURLToPath(new URL('../src/bridge.js', import.meta.url));
  const script = `
    globalThis.fetch = async (url, init) => {
      if (init.method === 'DELETE') {
        process.stderr.write('DELETE-SENT\\n');
        return { status: 204, ok: true, headers: new Headers(), text: async () => '', body: { cancel: async () => {} } };
      }
      return {
        status: 200, ok: true,
        headers: new Headers({ 'mcp-session-id': 'sess-1', 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
        body: { cancel: async () => {} },
      };
    };
    const { main } = await import(${JSON.stringify(src)});
    await main();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, NUMERATICA_API_KEY: 'k' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', () => {});
  // Send one request and deliberately leave stdin OPEN, so only the signal can end it.
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');

  await new Promise((r) => setTimeout(r, 500));
  child.kill('SIGINT');

  const exited = await Promise.race([
    new Promise((r) => child.on('exit', (code) => r({ code }))),
    new Promise((r) => setTimeout(() => r({ code: 'HUNG' }), 6000)),
  ]);
  if (exited.code === 'HUNG') child.kill('SIGKILL');

  assert.notEqual(exited.code, 'HUNG', 'SIGINT must terminate the process');
  assert.match(stderr, /DELETE-SENT/, 'the session must be terminated on the signal path');
});

test('the published config matches what CI actually exercises', () => {
  // #16 changed config but asserted none of it, so "every finding has a test" was
  // not true for the finding about tests.
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const ci = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  const testTsconfig = readFileSync(fileURLToPath(new URL('./tsconfig.json', import.meta.url)), 'utf8');

  assert.equal(pkg.engines.node, '>=20', 'Node 18 is EOL and was never exercised');
  assert.match(pkg.scripts.prepublishOnly ?? '', /typecheck.*test|test.*typecheck/, 'publish must be gated on green');

  const matrix = (ci.match(/node-version:\s*\[([^\]]+)\]/) ?? [])[1] ?? '';
  const versions = matrix.split(',').map((v) => v.trim());
  assert.ok(versions.includes('20'), 'the declared engines floor must be in the matrix');
  for (const v of versions) {
    assert.match(v, /^\d+$/, `unexpected matrix entry ${v}`);
  }

  // @types/node must track the runtimes actually typechecked, or the types describe
  // a Node the code never runs on.
  const typesMajor = Number((pkg.devDependencies['@types/node'].match(/(\d+)/) ?? [])[1]);
  assert.ok(
    typesMajor >= Number(pkg.engines.node.replace(/\D/g, '')),
    `@types/node ${typesMajor} is older than the engines floor`,
  );

  // The root config covers bin+src; test/ has its own so prepublishOnly's typecheck
  // actually looks at the test files too, which it previously never did.
  assert.match(pkg.scripts.typecheck, /-p test/, 'typecheck must cover test/ as well as src/');
  assert.match(testTsconfig, /"extends"/, 'the test config must inherit the real settings');
});

// --- discovery-only mode (no API key) ----------------------------------------

const NO_KEY = { baseUrl: 'https://api.example.com' }; // note: no apiKey

test('keyless: tools/list is forwarded with NO Authorization header at all', async () => {
  let seenInit = /** @type {any} */ (null);
  const fetchMock = async (_url, init) => {
    seenInit = init;
    return mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' });
  };
  const out = await forward('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', { ...NO_KEY, fetch: fetchMock });

  assert.equal(out.length, 1, 'discovery must work without a key');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(seenInit.headers, 'Authorization'),
    'the property must be ABSENT, not empty — the server treats any value as a credential',
  );
  // The rest of the contract is unchanged.
  assert.equal(seenInit.headers.Accept, 'application/json, text/event-stream');
});

test('keyless: no header anywhere contains the string "undefined"', async () => {
  // `Bearer ${undefined}` interpolates to "Bearer undefined" — a credential-shaped
  // value the server would look up and reject, turning "no key" into "bad key" and
  // destroying anonymous discovery. Checking for an empty value would not catch it.
  let seenInit = /** @type {any} */ (null);
  const fetchMock = async (_url, init) => {
    seenInit = init;
    return mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
  };
  await forward('{"jsonrpc":"2.0","id":1,"method":"initialize"}', { ...NO_KEY, fetch: fetchMock });
  for (const [name, value] of Object.entries(seenInit.headers)) {
    assert.doesNotMatch(String(value), /undefined/i, `header ${name} leaked an undefined`);
  }
});

test('keyless: tools/call makes ZERO upstream requests and says where to get a key', async () => {
  let calls = 0;
  const fetchMock = async () => {
    calls++;
    return mockResponse({});
  };
  const out = await forward('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"tvm"}}', {
    ...NO_KEY,
    fetch: fetchMock,
  });

  assert.equal(calls, 0, 'no point spending a round trip to be told what we already know');
  const err = JSON.parse(out[0]).error;
  assert.equal(JSON.parse(out[0]).id, 8, 'the id must still correlate');
  assert.match(err.message, /NUMERATICA_API_KEY/, 'name the variable to set');
  assert.match(err.message, /https:\/\/docs\.numeratica\.com/, 'and where to get a key');
});

test('keyless: a notification still produces no output', async () => {
  const fetchMock = async () => mockResponse({ status: 202 });
  const out = await forward('{"jsonrpc":"2.0","method":"notifications/initialized"}', { ...NO_KEY, fetch: fetchMock });
  assert.deepEqual(out, []);
});

test('keyless: a tools/call notification produces no output either', async () => {
  // Belt and braces: the short-circuit must not invent a frame for a message that
  // had no id, which would corrupt the stream.
  let calls = 0;
  const fetchMock = async () => {
    calls++;
    return mockResponse({ status: 202 });
  };
  const out = await forward('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tvm"}}', {
    ...NO_KEY,
    fetch: fetchMock,
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test('with a key: the request is byte-identical to before this change', async () => {
  let seenInit = /** @type {any} */ (null);
  const fetchMock = async (_url, init) => {
    seenInit = init;
    return mockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
  };
  const req = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tvm"}}';
  const out = await forward(req, { ...BASE, fetch: fetchMock });

  assert.equal(seenInit.headers.Authorization, 'Bearer sek_test');
  assert.equal(seenInit.headers['Content-Type'], 'application/json');
  assert.equal(seenInit.headers.Accept, 'application/json, text/event-stream');
  assert.equal(seenInit.body, req, 'still forwarded verbatim');
  assert.equal(out.length, 1);
  assert.match(out[0], /"result"/, 'a keyed tools/call must reach the server, not the short-circuit');
});
