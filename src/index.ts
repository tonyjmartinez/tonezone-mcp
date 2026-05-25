export interface Env {
  DB: D1Database;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Entry {
  id: number;
  text: string;
  label: string | null;
  created_at: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── CORS headers ─────────────────────────────────────────────────────────────

function cors(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body: unknown, status = 200, origin = "*"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function storeEntry(db: D1Database, text: string, label?: string): Promise<Entry> {
  const result = await db
    .prepare("INSERT INTO entries (text, label) VALUES (?, ?) RETURNING *")
    .bind(text, label ?? null)
    .first<Entry>();
  if (!result) throw new Error("Insert failed");
  return result;
}

async function getEntries(db: D1Database, limit = 50): Promise<Entry[]> {
  const result = await db
    .prepare("SELECT * FROM entries ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<Entry>();
  return result.results;
}

async function deleteEntry(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM entries WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

// ─── MCP handler ─────────────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: "store_text",
    description: "Store a text entry in the database, optionally with a label.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to store" },
        label: { type: "string", description: "Optional label/category" },
      },
      required: ["text"],
    },
  },
  {
    name: "get_texts",
    description: "Retrieve stored text entries, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries to return (default 20, max 100)" },
      },
    },
  },
  {
    name: "delete_text",
    description: "Delete a stored text entry by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The entry ID to delete" },
      },
      required: ["id"],
    },
  },
];

async function handleMcp(req: JsonRpcRequest, db: D1Database): Promise<JsonRpcResponse> {
  const { method, params, id } = req;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tonezone-mcp", version: "0.1.0" },
      },
    };
  }

  if (method === "notifications/initialized") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }

  if (method === "tools/call") {
    const toolName = (params as { name?: string })?.name;
    const args = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};

    try {
      if (toolName === "store_text") {
        const text = args.text as string;
        if (!text) throw new Error("text is required");
        const entry = await storeEntry(db, text, args.label as string | undefined);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Stored entry #${entry.id}: "${entry.text}"` }],
          },
        };
      }

      if (toolName === "get_texts") {
        const limit = Math.min(Number(args.limit ?? 20), 100);
        const entries = await getEntries(db, limit);
        const text =
          entries.length === 0
            ? "No entries stored yet."
            : entries.map((e) => `#${e.id} [${e.label ?? "—"}] ${e.text} (${e.created_at})`).join("\n");
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        };
      }

      if (toolName === "delete_text") {
        const entryId = Number(args.id);
        if (!entryId) throw new Error("id is required");
        const deleted = await deleteEntry(db, entryId);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: deleted ? `Deleted entry #${entryId}` : `Entry #${entryId} not found` }],
          },
        };
      }

      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
    } catch (err) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: String(err) } };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

// ─── Demo page ───────────────────────────────────────────────────────────────

const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ToneZone MCP — Demo</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
    @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #09090e;
      color: #e8e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2.5rem 1rem;
    }
    .hero { text-align: center; margin-bottom: 2.5rem; animation: fadeIn .4s ease; }
    h1 {
      font-size: 2.2rem;
      font-weight: 800;
      letter-spacing: -.02em;
      background: linear-gradient(135deg, #a78bfa 0%, #60a5fa 60%, #34d399 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: .35rem;
    }
    .subtitle { color: #666; font-size: .875rem; }
    .subtitle strong { color: #888; font-weight: 500; }
    .card {
      background: #111118;
      border: 1px solid #1e1e2e;
      border-radius: 14px;
      padding: 1.5rem;
      width: 100%;
      max-width: 640px;
      margin-bottom: 1.25rem;
      animation: fadeIn .35s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,.4);
    }
    .card:hover { border-color: #2a2a40; }
    h2 {
      font-size: .8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 1rem;
      color: #555577;
    }
    .row { display: flex; gap: .75rem; margin-bottom: .75rem; }
    input[type="text"] {
      flex: 1;
      background: #0a0a12;
      border: 1px solid #1e1e2e;
      border-radius: 8px;
      color: #e8e8f0;
      font-size: .9rem;
      padding: .65rem 1rem;
      outline: none;
      transition: border-color .15s, box-shadow .15s;
    }
    input[type="text"]:focus {
      border-color: #7c3aed;
      box-shadow: 0 0 0 3px rgba(124,58,237,.15);
    }
    button {
      background: linear-gradient(135deg, #6d28d9, #4f46e5);
      border: none;
      border-radius: 8px;
      color: #fff;
      cursor: pointer;
      font-size: .85rem;
      font-weight: 600;
      padding: .65rem 1.25rem;
      transition: opacity .15s, transform .1s, box-shadow .15s;
      box-shadow: 0 2px 8px rgba(109,40,217,.35);
    }
    button:hover { opacity: .9; transform: translateY(-1px); box-shadow: 0 4px 14px rgba(109,40,217,.45); }
    button:active { transform: translateY(0); }
    button.danger {
      background: linear-gradient(135deg, #7f1d1d, #991b1b);
      box-shadow: 0 2px 8px rgba(153,27,27,.3);
    }
    button.danger:hover { box-shadow: 0 4px 14px rgba(153,27,27,.4); }
    button.small { font-size: .72rem; padding: .3rem .65rem; box-shadow: none; }
    #status { font-size: .8rem; color: #555; margin-top: .5rem; min-height: 1.2em; }
    #status.ok { color: #34d399; }
    #status.err { color: #f87171; }
    #entries { list-style: none; }
    #entries li {
      display: flex;
      align-items: flex-start;
      gap: .75rem;
      padding: .8rem 0;
      border-bottom: 1px solid #16161f;
    }
    #entries li:last-child { border-bottom: none; }
    .entry-id { color: #333355; font-size: .72rem; min-width: 2rem; padding-top: .15rem; font-variant-numeric: tabular-nums; }
    .entry-body { flex: 1; }
    .entry-text { font-size: .92rem; word-break: break-word; color: #d0d0e8; }
    .entry-meta { color: #444466; font-size: .72rem; margin-top: .25rem; }
    .empty { color: #333355; text-align: center; padding: 1.5rem 0; font-size: .88rem; }
    .mcp-info {
      background: #0a0a12;
      border: 1px solid #1e1e2e;
      border-radius: 8px;
      padding: 1rem;
      font-family: monospace;
      font-size: .78rem;
      color: #5555aa;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.6;
    }
    .mcp-info .method { color: #a78bfa; }
    .tag {
      display: inline-block;
      background: #1e1040;
      border-radius: 4px;
      font-size: .68rem;
      padding: .15rem .45rem;
      color: #7c5fe6;
      margin-right: .4rem;
      font-weight: 500;
    }
    .live-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      background: #34d399;
      border-radius: 50%;
      margin-right: .45rem;
      vertical-align: middle;
      animation: pulse 2s ease-in-out infinite;
      box-shadow: 0 0 6px #34d399;
    }
  </style>
</head>
<body>
  <div class="hero">
    <h1>ToneZone MCP</h1>
    <p class="subtitle">Persistent text store &nbsp;·&nbsp; <strong>Cloudflare Workers + D1</strong></p>
  </div>

  <div class="card">
    <h2>Store Text</h2>
    <div class="row">
      <input id="text-input" type="text" placeholder="Enter text to store…" />
      <input id="label-input" type="text" placeholder="Label (optional)" style="max-width:160px" />
    </div>
    <div class="row">
      <button onclick="storeText()">Store</button>
    </div>
    <div id="status"></div>
  </div>

  <div class="card">
    <h2>Stored Entries <button class="small" onclick="loadEntries()" style="margin-left:.5rem">↻ Refresh</button></h2>
    <ul id="entries"><li class="empty">Loading…</li></ul>
  </div>

  <div class="card">
    <h2><span class="live-dot"></span>MCP Endpoint</h2>
    <div class="mcp-info" id="mcp-url">POST <origin>/mcp

Content-Type: application/json

{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }</div>
  </div>

  <script>
    const BASE = window.location.origin;
    document.getElementById('mcp-url').textContent =
      \`POST \${BASE}/mcp\\n\\nContent-Type: application/json\\nAccept: application/json\\n\\n{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }\`;

    function setStatus(msg, type = '') {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.className = type;
    }

    async function storeText() {
      const text = document.getElementById('text-input').value.trim();
      const label = document.getElementById('label-input').value.trim();
      if (!text) { setStatus('Text is required', 'err'); return; }
      setStatus('Storing…');
      try {
        const r = await fetch(\`\${BASE}/api/entries\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, label: label || undefined }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? r.statusText);
        setStatus(\`Stored #\${d.id}\`, 'ok');
        document.getElementById('text-input').value = '';
        document.getElementById('label-input').value = '';
        loadEntries();
      } catch (e) {
        setStatus(String(e), 'err');
      }
    }

    async function deleteEntry(id) {
      try {
        await fetch(\`\${BASE}/api/entries/\${id}\`, { method: 'DELETE' });
        loadEntries();
      } catch (e) {
        alert(String(e));
      }
    }

    async function loadEntries() {
      try {
        const r = await fetch(\`\${BASE}/api/entries\`);
        const entries = await r.json();
        const ul = document.getElementById('entries');
        if (!entries.length) {
          ul.innerHTML = '<li class="empty">No entries yet — store something above!</li>';
          return;
        }
        ul.innerHTML = entries.map(e => \`
          <li>
            <span class="entry-id">#\${e.id}</span>
            <div class="entry-body">
              \${e.label ? \`<span class="tag">\${e.label}</span>\` : ''}
              <span class="entry-text">\${escHtml(e.text)}</span>
              <div class="entry-meta">\${e.created_at} UTC</div>
            </div>
            <button class="small danger" onclick="deleteEntry(\${e.id})">Delete</button>
          </li>
        \`).join('');
      } catch (e) {
        document.getElementById('entries').innerHTML = \`<li class="empty" style="color:#ee4444">\${e}</li>\`;
      }
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    document.getElementById('text-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') storeText();
    });

    loadEntries();
  </script>
</body>
</html>`;

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "*";
    const method = request.method.toUpperCase();

    // Preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // ── Demo page ──
    if (url.pathname === "/" && method === "GET") {
      return new Response(DEMO_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ── REST API ──
    if (url.pathname === "/api/entries" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
      const entries = await getEntries(env.DB, limit);
      return jsonResponse(entries, 200, origin);
    }

    if (url.pathname === "/api/entries" && method === "POST") {
      let body: { text?: string; label?: string };
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400, origin);
      }
      if (!body.text) return jsonResponse({ error: "text is required" }, 400, origin);
      const entry = await storeEntry(env.DB, body.text, body.label);
      return jsonResponse(entry, 201, origin);
    }

    if (url.pathname.startsWith("/api/entries/") && method === "DELETE") {
      const id = Number(url.pathname.split("/").pop());
      if (!id) return jsonResponse({ error: "invalid id" }, 400, origin);
      const deleted = await deleteEntry(env.DB, id);
      return jsonResponse({ deleted }, deleted ? 200 : 404, origin);
    }

    // ── MCP endpoint ──
    if (url.pathname === "/mcp" && method === "POST") {
      let body: JsonRpcRequest;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400, origin);
      }
      const response = await handleMcp(body, env.DB);
      return jsonResponse(response, 200, origin);
    }

    return new Response("Not Found", { status: 404 });
  },
};
