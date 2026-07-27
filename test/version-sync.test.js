import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The version number lives in THREE places that nothing else forces to agree:
//
//   package.json .version          — what `npm publish` uploads
//   server.json  .version          — the registry entry's own version
//   server.json  .packages[0].version — the npm version the registry entry POINTS AT
//
// The third is the dangerous one: if it drifts, the MCP registry advertises a
// package version that does not exist on npm, and every client that resolves the
// listing gets a 404 on install. Nothing in `npm version` or `mcp-publisher`
// touches the other copies, so the only thing standing between us and a broken
// listing is this test.
//
// This is the same defect class as a rate table transcribed twice: two copies of a
// number, no mechanism asserting they match, and the disagreement only surfaces to
// whoever consumes the wrong copy.

const read = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'));

test('server.json, its npm package entry, and package.json all carry the same version', () => {
  const pkg = read('package.json');
  const server = read('server.json');

  assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'package.json version should be semver');
  assert.equal(
    server.version,
    pkg.version,
    'server.json .version drifted from package.json — the registry entry would be stamped with the wrong release',
  );

  const npmPkg = server.packages.find((p) => p.registryType === 'npm');
  assert.ok(npmPkg, 'server.json should declare an npm package');
  assert.equal(
    npmPkg.version,
    pkg.version,
    'server.json .packages[npm].version drifted — the registry would point clients at an npm version that may not exist',
  );
  assert.equal(
    npmPkg.identifier,
    pkg.name,
    'server.json npm identifier should match the published package name',
  );
});

test('package.json mcpName matches the registry namespace', () => {
  // The MCP Registry refuses to publish unless the npm package names the namespace
  // back — it fetches the PUBLISHED tarball and reads package.json .mcpName, which is
  // how it knows @numeratica/mcp is really ours and not someone squatting the listing.
  //
  // The trap: it validates the tarball, not the working tree, so a mismatch cannot be
  // fixed in place — it needs a fresh npm release. That is why this is a test and not
  // something we check at publish time, when the only remedy is another version bump.
  const pkg = read('package.json');
  const server = read('server.json');
  assert.equal(
    pkg.mcpName,
    server.name,
    'package.json .mcpName must equal server.json .name, or the registry rejects the publish',
  );
});

test('server.json declares the env vars the bridge actually reads', () => {
  const server = read('server.json');
  const bridge = readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8');

  // Guards against the failure the scaffold shipped with: `mcp-publisher init`
  // guessed a placeholder `YOUR_API_KEY`, which would have told every client to set
  // an env var the bridge never reads. Anchor the manifest to the source instead.
  const declared = new Set(
    server.packages.flatMap((p) => (p.environmentVariables ?? []).map((e) => e.name)),
  );
  for (const name of bridge.match(/NUMERATICA_[A-Z_]+/g) ?? []) {
    assert.ok(declared.has(name), `${name} is read by src/bridge.js but not declared in server.json`);
  }

  const key = server.packages[0].environmentVariables.find((e) => e.name === 'NUMERATICA_API_KEY');
  assert.equal(key.isRequired, true);
  assert.equal(key.isSecret, true, 'the API key must be marked secret so clients do not log it');
});
