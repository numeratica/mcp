// Numeratica MCP bridge — a stdio <-> hosted /mcp transport shim.
//
// It is deliberately dumb: it knows nothing about the tool catalog or any
// calculation. Every JSON-RPC message read from stdin is forwarded verbatim to
// the hosted /mcp endpoint and the response is written back to stdout. So
// `initialize`, `tools/list`, and `tools/call` are all answered by the server —
// the bridge auto-syncs with the API and can leak nothing about it.

import { createInterface } from 'node:readline';

const DEFAULT_BASE_URL = 'https://api.numeratica.com';

/**
 * @typedef {Object} Config
 * @property {string|undefined} apiKey
 * @property {string} baseUrl
 */

/**
 * Resolve configuration from argv (`--key <value>`) and the environment.
 * @param {string[]} argv  process args (without node/script)
 * @param {Record<string,string|undefined>} env
 * @returns {Config}
 */
export function loadConfig(argv, env) {
  let apiKey = env.NUMERATICA_API_KEY;
  const i = argv.indexOf('--key');
  if (i !== -1 && argv[i + 1]) apiKey = argv[i + 1];
  const baseUrl = (env.NUMERATICA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

/**
 * Validate config. Returns an error message string if invalid, else null.
 * The message never contains the key (there is nothing to leak when it's absent).
 * @param {Config} config
 * @returns {string|null}
 */
export function validateConfig(config) {
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
 * Forward one raw JSON-RPC line to the hosted endpoint. Returns the text to
 * write to stdout, or null when there is nothing to write (a notification ack).
 * @param {string} line
 * @param {{ baseUrl: string, apiKey: string, fetch: typeof globalThis.fetch }} opts
 * @returns {Promise<string|null>}
 */
export async function forward(line, opts) {
  const body = line.trim();
  if (!body) return null;

  // Parse only to learn the id and whether this is a notification (no `id`), so
  // we can echo a matching id on error. The body is still forwarded verbatim.
  let id = null;
  let isNotification = false;
  try {
    const msg = JSON.parse(body);
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      id = msg.id ?? null;
      isNotification = msg.id === undefined;
    }
  } catch {
    // Not valid JSON; forward as-is. We just can't echo a matching id on error.
  }

  let res;
  try {
    res = await opts.fetch(`${opts.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });
  } catch (err) {
    if (isNotification) return null;
    const detail = err instanceof Error ? err.message : 'unknown error';
    return jsonRpcError(id, -32000, `transport error contacting Numeratica: ${detail}`);
  }

  // Notification acks (202/204) carry no body — write nothing.
  if (res.status === 202 || res.status === 204) return null;

  const text = (await res.text()).trim();

  if (!res.ok) {
    if (isNotification) return null;
    const detail = text ? `: ${text.slice(0, 500)}` : '';
    return jsonRpcError(id, -32000, `Numeratica API error (HTTP ${res.status})${detail}`);
  }

  return text === '' ? null : text;
}

/**
 * Run the bridge: read newline-delimited JSON-RPC from `stdin`, forward each
 * message in order, and write each response with `write`. Resolves on stdin EOF.
 * @param {{ stdin: NodeJS.ReadableStream, write: (s: string) => void, fetch: typeof globalThis.fetch, baseUrl: string, apiKey: string }} opts
 * @returns {Promise<void>}
 */
export async function run(opts) {
  const rl = createInterface({ input: opts.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const out = await forward(line, opts);
    if (out !== null) opts.write(out);
  }
}

/** CLI entrypoint: wire process stdio + global fetch, or exit cleanly on misconfig. */
export async function main() {
  const config = loadConfig(process.argv.slice(2), process.env);
  const err = validateConfig(config);
  if (err) {
    process.stderr.write(`numeratica-mcp: ${err}\n`);
    process.exit(1);
    return;
  }
  await run({
    stdin: process.stdin,
    write: (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n'),
    fetch: globalThis.fetch,
    baseUrl: config.baseUrl,
    apiKey: /** @type {string} */ (config.apiKey),
  });
  process.exit(0);
}
