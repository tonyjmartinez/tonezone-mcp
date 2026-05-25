export interface Env {
  DB: D1Database;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Entry {
  id: number;
  namespace: string;
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

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function sanitizeNs(ns: unknown): string {
  const s = String(ns ?? "").trim().slice(0, 128);
  return s || "default";
}

async function storeEntry(db: D1Database, namespace: string, text: string, label?: string): Promise<Entry> {
  const result = await db
    .prepare("INSERT INTO entries (namespace, text, label) VALUES (?, ?, ?) RETURNING *")
    .bind(namespace, text, label ?? null)
    .first<Entry>();
  if (!result) throw new Error("Insert failed");
  return result;
}

async function getEntries(db: D1Database, namespace: string, limit = 50): Promise<Entry[]> {
  const result = await db
    .prepare("SELECT * FROM entries WHERE namespace = ? ORDER BY created_at DESC LIMIT ?")
    .bind(namespace, limit)
    .all<Entry>();
  return result.results;
}

async function deleteEntry(db: D1Database, namespace: string, id: number): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM entries WHERE id = ? AND namespace = ?")
    .bind(id, namespace)
    .run();
  return result.meta.changes > 0;
}

// ─── MCP handler ─────────────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: "store_text",
    description: "Store a text entry in the database under a namespace.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace token (acts as the storage key — keep it secret to keep your data private)" },
        text: { type: "string", description: "The text to store" },
        label: { type: "string", description: "Optional label/category" },
      },
      required: ["namespace", "text"],
    },
  },
  {
    name: "get_texts",
    description: "Retrieve stored text entries for a namespace, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace token" },
        limit: { type: "number", description: "Max entries to return (default 20, max 100)" },
      },
      required: ["namespace"],
    },
  },
  {
    name: "delete_text",
    description: "Delete a stored text entry by ID within a namespace.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace token" },
        id: { type: "number", description: "The entry ID to delete" },
      },
      required: ["namespace", "id"],
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
        serverInfo: { name: "tonezone-mcp", version: "0.2.0" },
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
    const ns = sanitizeNs(args.namespace);

    try {
      if (toolName === "store_text") {
        const text = args.text as string;
        if (!text) throw new Error("text is required");
        const entry = await storeEntry(db, ns, text, args.label as string | undefined);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Stored entry #${entry.id} in namespace "${ns}": "${entry.text}"` }],
          },
        };
      }

      if (toolName === "get_texts") {
        const limit = Math.min(Number(args.limit ?? 20), 100);
        const entries = await getEntries(db, ns, limit);
        const text =
          entries.length === 0
            ? `No entries in namespace "${ns}" yet.`
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
        const deleted = await deleteEntry(db, ns, entryId);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: deleted ? `Deleted entry #${entryId}` : `Entry #${entryId} not found in namespace "${ns}"` }],
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
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f0f13;
      color: #e8e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
    }
    h1 { font-size: 1.8rem; font-weight: 700; margin-bottom: .25rem; }
    .subtitle { color: #888; font-size: .9rem; margin-bottom: 2rem; }
    .card {
      background: #1a1a24;
      border: 1px solid #2a2a3a;
      border-radius: 12px;
      padding: 1.5rem;
      width: 100%;
      max-width: 640px;
      margin-bottom: 1.5rem;
    }
    h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: #a0a0c0; }
    .row { display: flex; gap: .75rem; margin-bottom: .75rem; align-items: center; }
    input[type="text"] {
      flex: 1;
      background: #0f0f18;
      border: 1px solid #2a2a3a;
      border-radius: 8px;
      color: #e8e8f0;
      font-size: .9rem;
      padding: .6rem .9rem;
      outline: none;
    }
    input[type="text"]:focus { border-color: #5555ee; }
    button {
      background: #4444dd;
      border: none;
      border-radius: 8px;
      color: #fff;
      cursor: pointer;
      font-size: .85rem;
      font-weight: 600;
      padding: .6rem 1.1rem;
      transition: background .15s;
      white-space: nowrap;
    }
    button:hover { background: #5555ee; }
    button.danger { background: #882222; }
    button.danger:hover { background: #aa3333; }
    button.ghost {
      background: transparent;
      border: 1px solid #2a2a3a;
      color: #a0a0c0;
      font-size: .8rem;
      padding: .4rem .8rem;
    }
    button.ghost:hover { background: #2a2a3a; color: #e8e8f0; }
    button.small { font-size: .75rem; padding: .35rem .7rem; }
    #status { font-size: .8rem; color: #888; margin-top: .5rem; min-height: 1.2em; }
    #status.ok { color: #44cc88; }
    #status.err { color: #ee4444; }
    #entries { list-style: none; }
    #entries li {
      display: flex;
      align-items: flex-start;
      gap: .75rem;
      padding: .75rem 0;
      border-bottom: 1px solid #22223a;
    }
    #entries li:last-child { border-bottom: none; }
    .entry-id { color: #555; font-size: .75rem; min-width: 2rem; padding-top: .1rem; }
    .entry-body { flex: 1; }
    .entry-text { font-size: .95rem; word-break: break-word; }
    .entry-meta { color: #666; font-size: .75rem; margin-top: .2rem; }
    .empty { color: #555; text-align: center; padding: 1rem 0; font-size: .9rem; }
    .ns-token {
      font-family: monospace;
      font-size: .85rem;
      background: #0f0f18;
      border: 1px solid #2a2a3a;
      border-radius: 8px;
      padding: .5rem .8rem;
      color: #88aaff;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mcp-info {
      background: #0f0f18;
      border: 1px solid #2a2a3a;
      border-radius: 8px;
      padding: 1rem;
      font-family: monospace;
      font-size: .8rem;
      color: #a0a0c0;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .tag {
      display: inline-block;
      background: #2a2a4a;
      border-radius: 4px;
      font-size: .7rem;
      padding: .15rem .4rem;
      color: #8888cc;
      margin-right: .4rem;
    }
    .hint { color: #555; font-size: .78rem; margin-top: .5rem; }
  </style>
</head>
<body>
  <h1>ToneZone MCP</h1>
  <p class="subtitle">Persistent text store · Cloudflare Workers + D1</p>

  <div class="card">
    <h2>Your Namespace</h2>
    <div class="row">
      <span class="ns-token" id="ns-display"></span>
      <button class="ghost" onclick="copyNs()">Copy</button>
      <button class="ghost" onclick="newNs()">New</button>
    </div>
    <p class="hint">This token is your storage key. Anyone with it can read and write your data — keep it private or share it intentionally.</p>
  </div>

  <div class="card">
    <h2>Store Text</h2>
    <div class="row">
      <input id="text-input" type="text" placeholder="Enter text to store…" />
      <input id="label-input" type="text" placeholder="Label (optional)" style="max-width:140px" />
    </div>
    <div class="row">
      <button onclick="storeText()">Store</button>
    </div>
    <div id="status"></div>
  </div>

  <div class="card">
    <h2>Stored Entries <button class="small ghost" onclick="loadEntries()">Refresh</button></h2>
    <ul id="entries"><li class="empty">Loading…</li></ul>
  </div>

  <div class="card">
    <h2>MCP Endpoint</h2>
    <div class="mcp-info" id="mcp-url"></div>
  </div>

  <script>
    const BASE = window.location.origin;
    const NS_KEY = 'tz_namespace';

    function getNs() {
      return localStorage.getItem(NS_KEY) || generateNs();
    }

    function generateNs() {
      const ns = 'tz_' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(NS_KEY, ns);
      return ns;
    }

    function renderNs() {
      const ns = getNs();
      document.getElementById('ns-display').textContent = ns;
      document.getElementById('mcp-url').textContent =
        \`POST \${BASE}/mcp\\n\\nContent-Type: application/json\\n\\n{\\n  "jsonrpc": "2.0",\\n  "id": 1,\\n  "method": "tools/call",\\n  "params": {\\n    "name": "store_text",\\n    "arguments": {\\n      "namespace": "\${ns}",\\n      "text": "hello from claude"\\n    }\\n  }\\n}\`;
    }

    function copyNs() {
      navigator.clipboard.writeText(getNs());
    }

    function newNs() {
      if (!confirm('Generate a new namespace? You will lose access to entries stored under the current one.')) return;
      localStorage.removeItem(NS_KEY);
      generateNs();
      renderNs();
      loadEntries();
    }

    function authHeaders() {
      return { 'Content-Type': 'application/json' };
    }

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
          headers: authHeaders(),
          body: JSON.stringify({ namespace: getNs(), text, label: label || undefined }),
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
        await fetch(\`\${BASE}/api/entries/\${id}?ns=\${encodeURIComponent(getNs())}\`, { method: 'DELETE' });
        loadEntries();
      } catch (e) {
        alert(String(e));
      }
    }

    async function loadEntries() {
      try {
        const r = await fetch(\`\${BASE}/api/entries?ns=\${encodeURIComponent(getNs())}\`);
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

    renderNs();
    loadEntries();
  </script>
</body>
</html>`;

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // Preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Demo page ──
    if (url.pathname === "/" && method === "GET") {
      return new Response(DEMO_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ── REST API ──
    if (url.pathname === "/api/entries" && method === "GET") {
      const ns = sanitizeNs(url.searchParams.get("ns"));
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
      const entries = await getEntries(env.DB, ns, limit);
      return jsonResponse(entries, 200);
    }

    if (url.pathname === "/api/entries" && method === "POST") {
      let body: { namespace?: string; text?: string; label?: string };
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }
      if (!body.text) return jsonResponse({ error: "text is required" }, 400);
      const ns = sanitizeNs(body.namespace);
      const entry = await storeEntry(env.DB, ns, body.text, body.label);
      return jsonResponse(entry, 201);
    }

    if (url.pathname.startsWith("/api/entries/") && method === "DELETE") {
      const id = Number(url.pathname.split("/").pop());
      const ns = sanitizeNs(url.searchParams.get("ns"));
      if (!id) return jsonResponse({ error: "invalid id" }, 400);
      const deleted = await deleteEntry(env.DB, ns, id);
      return jsonResponse({ deleted }, deleted ? 200 : 404);
    }

    // ── MCP endpoint ──
    if (url.pathname === "/mcp" && method === "POST") {
      let body: JsonRpcRequest;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      const response = await handleMcp(body, env.DB);
      return jsonResponse(response, 200);
    }

    return new Response("Not Found", { status: 404 });
  },
};
