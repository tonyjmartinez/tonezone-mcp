# tonezone-mcp

Minimal MCP server + REST API + demo page on Cloudflare Workers with D1 (SQLite) storage.

## What it does

- **MCP server** at `POST /mcp` — JSON-RPC 2.0, tools: `store_text`, `get_texts`, `delete_text`
- **REST API** at `/api/entries` — for the demo page and direct use
- **Demo page** at `/` — store and browse text entries in the browser

## Deploy

### 1. Install deps

```bash
npm install
```

### 2. Create the D1 database

```bash
npm run db:create
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
database_id = "your-actual-id-here"
```

### 3. Run the schema

```bash
# local dev
npm run db:migrate:local

# production
npm run db:migrate
```

### 4. Local dev

```bash
npm run dev
```

### 5. Deploy

```bash
npm run deploy
```

## MCP tools

| Tool | Description |
|------|-------------|
| `store_text` | Store text with optional label |
| `get_texts` | Get stored entries (newest first) |
| `delete_text` | Delete entry by ID |

### Example — call from a Claude artifact

```js
const res = await fetch('https://your-worker.workers.dev/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'store_text',
      arguments: { text: 'hello from artifact', label: 'test' }
    }
  })
});
const { result } = await res.json();
console.log(result.content[0].text);
```

## MCP initialization flow (for Claude Desktop / Cline / etc.)

```
POST /mcp  { method: "initialize" }
POST /mcp  { method: "tools/list" }
POST /mcp  { method: "tools/call", params: { name: "...", arguments: {...} } }
```
