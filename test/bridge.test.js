import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forward, run, loadConfig, validateConfig } from '../src/bridge.js';

/** Minimal stand-in for a fetch Response. */
function mockResponse({ status = 200, body = '' }) {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

test('forwards a tools/call to /mcp with the Bearer header and returns the response', async () => {
  let seenUrl;
  let seenInit;
  const fetchMock = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return mockResponse({ status: 200, body: '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}' });
  };
  const req = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"tvm"}}';
  const out = await forward(req, { baseUrl: 'https://api.example.com', apiKey: 'sek_test', fetch: fetchMock });

  assert.equal(seenUrl, 'https://api.example.com/mcp');
  assert.equal(seenInit.method, 'POST');
  assert.equal(seenInit.headers.Authorization, 'Bearer sek_test');
  assert.equal(seenInit.headers['Content-Type'], 'application/json');
  assert.equal(seenInit.body, req); // forwarded verbatim
  assert.match(out, /"id":7/);
});

test('a notification (no id, 202 ack) yields no stdout', async () => {
  let called = false;
  const fetchMock = async () => {
    called = true;
    return mockResponse({ status: 202, body: '' });
  };
  const out = await forward('{"jsonrpc":"2.0","method":"notifications/initialized"}', {
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetch: fetchMock,
  });
  assert.equal(called, true); // it IS forwarded...
  assert.equal(out, null); // ...but produces no output
});

test('run() writes one response per request and stops cleanly at EOF', async () => {
  const fetchMock = async () => mockResponse({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
  const writes = [];
  const stdin = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']);
  await run({ stdin, write: (s) => writes.push(s), fetch: fetchMock, baseUrl: 'https://x.test', apiKey: 'k' });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /"id":1/);
});

test('a non-2xx response is relayed as a JSON-RPC error carrying the request id', async () => {
  const fetchMock = async () => mockResponse({ status: 401, body: '{"error":{"code":"unauthorized"}}' });
  const out = await forward('{"jsonrpc":"2.0","id":3,"method":"tools/list"}', {
    baseUrl: 'https://x.test',
    apiKey: 'bad',
    fetch: fetchMock,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, 3);
  assert.ok(parsed.error);
  assert.match(parsed.error.message, /401/);
});

test('a pretty-printed (multi-line) upstream response is compacted to a single stdout line', async () => {
  // The hosted /mcp endpoint pretty-prints JSON; MCP stdio framing forbids embedded
  // newlines, so the bridge must collapse it to one line.
  const pretty = '{\n  "jsonrpc": "2.0",\n  "id": 9,\n  "result": { "ok": true }\n}';
  const fetchMock = async () => mockResponse({ status: 200, body: pretty });
  const out = await forward('{"jsonrpc":"2.0","id":9,"method":"tools/list"}', {
    baseUrl: 'https://x.test',
    apiKey: 'k',
    fetch: fetchMock,
  });
  assert.ok(!out.includes('\n'), 'output must not contain a newline');
  assert.deepEqual(JSON.parse(out), { jsonrpc: '2.0', id: 9, result: { ok: true } });
});

test('loadConfig: --key overrides env, default base url, trailing slash trimmed', () => {
  assert.equal(loadConfig([], {}).baseUrl, 'https://api.numeratica.com');
  const cfg = loadConfig(['--key', 'flagkey'], { NUMERATICA_API_KEY: 'envkey', NUMERATICA_BASE_URL: 'https://h.test/' });
  assert.equal(cfg.apiKey, 'flagkey');
  assert.equal(cfg.baseUrl, 'https://h.test');
});

test('validateConfig reports a missing key without leaking anything', () => {
  const msg = validateConfig(loadConfig([], {}));
  assert.ok(msg && /NUMERATICA_API_KEY/.test(msg));
  assert.match(msg, /docs\.numeratica\.com/);
});

test('the bin exits non-zero with a clear message and no stdout when the key is missing', () => {
  const bin = fileURLToPath(new URL('../bin/numeratica-mcp.js', import.meta.url));
  const r = spawnSync(process.execPath, [bin], {
    env: { PATH: process.env.PATH }, // no NUMERATICA_API_KEY
    input: '',
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /NUMERATICA_API_KEY is required/);
});
