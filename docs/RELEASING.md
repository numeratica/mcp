# Releasing

A release publishes **two** things from one tag: the npm package and the MCP
Registry entry. They are coupled — the registry entry names an npm version — so
they ship from the same job, npm first.

## The version number lives in four places

| Where | What it means |
| --- | --- |
| `package.json` `.version` | what npm publishes |
| `server.json` `.version` | the registry entry's own version |
| `server.json` `.packages[npm].version` | **the npm version the registry points clients at** |
| the git tag `v<x.y.z>` | what triggers the workflow |

The third is the one that bites: if it drifts, the registry advertises a package
version that doesn't exist and clients 404 on install. Nothing in `npm version`
updates the other copies.

Two guards, because no single one covers all four:

- `test/version-sync.test.js` — asserts the three in-repo copies agree. Runs on
  every CI build, not just releases.
- the **Tag matches package.json version** step in `publish.yml` — covers the tag,
  which is the copy nothing in the repo can see. It runs *before* `npm publish`,
  so a mismatched tag fails without shipping anything.

To cut a release, bump all three in-repo copies, let CI go green, then tag:

```bash
npm version patch --no-git-tag-version     # package.json only
# hand-edit server.json: .version AND .packages[0].version
npm test                                   # version-sync must pass
git commit -am 'release: v0.1.2' && git tag v0.1.2
git push && git push --tags
```

## Registry authentication

The namespace is `com.numeratica/mcp` — a **domain** namespace, so ownership is
proven against `numeratica.com`, not against GitHub. This rules out
`mcp-publisher login github-oidc` (the no-secret option), which the registry maps
to `io.github.<owner>/*` only.

**DNS TXT record**, on the **apex** — `numeratica.com`, i.e. `@` in Cloudflare.
Not `_mcp-auth.` or any other selector: MCP DNS auth is SPF-style (apex), not
DKIM-style (selector), and a record under a selector fails with a generic
signature error.

```
v=MCPv1; k=ed25519; p=U4ek+u6gAcyArJM7LRh0hYHkA3S/QPiU2GEKq43bJ34=
```

The matching **private key** is at `~/.numeratica/mcp-dns/` (mode 600) and is set
as the `MCP_PRIVATE_KEY` repo secret. It is a long-lived publishing credential:
anyone who can run a job that reads it can publish or overwrite **any**
`com.numeratica/*` server. Repo secrets are readable by every repository writer
via a tag or branch push, not just owners.

If you rotate it, **delete the old TXT record** — a stale one is tried first and
verification fails.

To generate a fresh keypair (macOS ships LibreSSL, which has no Ed25519 in
`genpkey`, hence the explicit openssl@3 path):

```bash
SSL=/opt/homebrew/opt/openssl@3/bin/openssl
$SSL genpkey -algorithm Ed25519 -out key.pem
$SSL pkey -in key.pem -pubout -outform DER | tail -c 32 | base64          # -> TXT p=
$SSL pkey -in key.pem -outform DER        | tail -c 32 | xxd -p -c 64     # -> MCP_PRIVATE_KEY
```

`mcp-publisher login dns --domain numeratica.com --private-key <hex>` prints the
proof record it expects, which is a useful cross-check against the value above
before touching DNS.

### Getting off the stored secret

`mcp-publisher login dns google-kms --domain numeratica.com --resource <keyVersion>`
signs with a Cloud KMS Ed25519 key under Application Default Credentials, so no
private key is stored in GitHub. That's the upgrade path if this credential's
blast radius stops being acceptable; it needs Workload Identity Federation wired
for this repo.
