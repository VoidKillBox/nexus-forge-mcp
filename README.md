# Nexus Forge MCP

**v2.2.0** — The spiritual successor to the Jit Skill Loader.

A standalone Model Context Protocol (MCP) server that discovers, vets, ranks, and bundles code skills from external repositories for just-in-time agent deployment. Serves any MCP client — Hermes, Antigravity IDE, Claude Desktop, etc.

## Quick Start

```bash
git clone https://github.com/VoidKillBox/nexus-forge-mcp.git
cd nexus-forge-mcp
./setup.sh
```

Or manually:
```bash
npm install && npx tsc
node build/index.js
```

## MCP Client Registration

```json
{
  "mcpServers": {
    "nexus-forge-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/nexus-forge-mcp/build/index.js"],
      "env": {
        "GITHUB_TOKEN": "your_github_pat_here"
      }
    }
  }
}
```

## Tools

### `discover_bundles`
List all available bundles from tracked repositories.
- `category` (optional) — filter by domain (e.g. `frontend`, `security`)

### `analyze_and_rank_skills`
Score and rank bundles against a project description using keyword-density analysis with stop-word filtering and length normalisation.
- `projectDescription` (required) — describe the target project
- `requirements` (optional) — array of explicit tool/skill needs
- `maxResults` (optional, default 5) — max recommendations to return

### `package_bundle`
Download, isolate, and archive a selected bundle into `<project>/.skills/` as `.zip` or `.tar.gz`.
- `bundleId` (required) — from the bundle manifest
- `projectName` (required) — target project directory name
- `outputFormat` (optional, default `zip`) — `zip` or `tar`

## Architecture

```
Client (Hermes / Antigravity / Claude Desktop)
    │ MCP stdio
    ▼
Nexus Forge MCP Server
    │
    ├─ discover_bundles        → ETag-validated manifest fetch
    ├─ analyze_and_rank_skills → keyword scoring + ranking
    └─ package_bundle           → sparse download → .skills/ → archive
```

Runtime state at `~/.config/nexus-forge-mcp/`:
- `config.json` — tracked repositories (auto-scaffolded)
- `cache.json` — ETag + manifest cache (atomic writes)

## Configuration

Add repositories to `~/.config/nexus-forge-mcp/config.json`:

```json
{
  "repositories": [
    {
      "name": "antigravity-skills",
      "bundlesUrl": "https://raw.githubusercontent.com/antigravity-ide/awesome-antigravity-skills/main/bundles.json",
      "rawContentBase": "https://raw.githubusercontent.com/antigravity-ide/awesome-antigravity-skills/main/skills/"
    }
  ]
}
```

## License

MIT
