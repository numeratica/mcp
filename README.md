# @numeratica/mcp

A thin [MCP](https://modelcontextprotocol.io) bridge that connects any MCP client (Claude Desktop, Cursor, …) to the **[Numeratica](https://docs.numeratica.com)** financial-planning API — retirement Monte Carlo, taxes, RMDs, Social Security, Roth conversions, and more.

**Get a free key at [https://docs.numeratica.com](https://docs.numeratica.com).**

## How it works

This package is a **transport bridge, nothing more**. It reads JSON-RPC from stdin and forwards each message to the hosted `POST /mcp` endpoint with your API key as a bearer token, then writes the response back to stdout. The tool list and all results come straight from the API — so the bridge always stays in sync and ships no calculation logic of its own. Your key is sent only in the `Authorization` header and **is never logged**.

- **Zero runtime dependencies** (Node ≥ 20 built-in `fetch` + `node:readline`).
- Open source (MIT). The interesting part is the API; this is just the wire.

## Install

No install needed — your MCP client runs it on demand with `npx`. (You can also `npm i -g @numeratica/mcp` to get the `numeratica-mcp` command.)

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "numeratica": {
      "command": "npx",
      "args": ["-y", "@numeratica/mcp"],
      "env": { "NUMERATICA_API_KEY": "nmr_sk_your_key_here" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or a project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "numeratica": {
      "command": "npx",
      "args": ["-y", "@numeratica/mcp"],
      "env": { "NUMERATICA_API_KEY": "nmr_sk_your_key_here" }
    }
  }
}
```

Restart the client and the Numeratica tools appear. Try: *"Run a retirement Monte Carlo for a 40-year-old retiring at 65."*

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NUMERATICA_API_KEY` | **yes** | — | Your key. Get one free at [docs.numeratica.com](https://docs.numeratica.com). Never logged. |
| `NUMERATICA_BASE_URL` | no | `https://api.numeratica.com` | Override the API base (e.g. for testing). |

You can also pass the key with `--key <value>` or `--key=<value>` instead of the env
var, but **prefer `NUMERATICA_API_KEY`**: a key on the command line is visible to
`ps` for every user on the machine, lands in shell history, and is stored verbatim
in MCP client config files that people routinely paste into issue reports. For a
non-env option that avoids all three, use `--key-file <path>`.

## Links

- **API docs & reference:** [https://docs.numeratica.com](https://docs.numeratica.com)
- **Get a free key:** [https://docs.numeratica.com/get-key](https://docs.numeratica.com/get-key)

## License

MIT © Numeratica / Francis Townsend-Merino
