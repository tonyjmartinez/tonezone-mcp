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

function generateNamespace(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "tz_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
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

// ─── MCP App UI resource ─────────────────────────────────────────────────────

const APP_RESOURCE_URI = "ui://tonezone-mcp/store";
const APP_MIME_TYPE = "text/html+mcp-app";

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ToneZone Store</title>
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
      padding: 1.5rem 1rem;
    }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: .2rem; }
    .sub { color: #555; font-size: .8rem; margin-bottom: 1.5rem; }
    .card { background: #1a1a24; border: 1px solid #2a2a3a; border-radius: 10px; padding: 1.1rem; width: 100%; max-width: 560px; margin-bottom: 1rem; }
    h2 { font-size: .8rem; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: .06em; margin-bottom: .7rem; }
    .row { display: flex; gap: .5rem; margin-bottom: .5rem; align-items: center; }
    input { flex: 1; background: #0f0f18; border: 1px solid #2a2a3a; border-radius: 7px; color: #e8e8f0; font-size: .9rem; padding: .5rem .75rem; outline: none; }
    input:focus { border-color: #5555ee; }
    button { background: #4444dd; border: none; border-radius: 7px; color: #fff; cursor: pointer; font-size: .82rem; font-weight: 600; padding: .5rem .9rem; transition: background .15s; white-space: nowrap; }
    button:hover:not(:disabled) { background: #5555ee; }
    button:disabled { opacity: .4; cursor: default; }
    button.ghost { background: transparent; border: 1px solid #2a2a3a; color: #888; font-size: .75rem; padding: .3rem .65rem; }
    button.ghost:hover:not(:disabled) { background: #2a2a3a; color: #e8e8f0; }
    button.del { background: #6a1a1a; font-size: .72rem; padding: .28rem .55rem; }
    button.del:hover:not(:disabled) { background: #993333; }
    .ns-box { font-family: monospace; font-size: .78rem; background: #0f0f18; border: 1px solid #2a2a3a; border-radius: 7px; padding: .45rem .7rem; color: #7799ff; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint { color: #444; font-size: .72rem; margin-top: .45rem; line-height: 1.4; }
    #msg { font-size: .78rem; min-height: 1.1em; margin-top: .35rem; }
    #msg.ok { color: #44cc88; }
    #msg.err { color: #ee4444; }
    ul { list-style: none; }
    li { display: flex; align-items: flex-start; gap: .6rem; padding: .6rem 0; border-bottom: 1px solid #1e1e2a; }
    li:last-child { border-bottom: none; }
    .eid { color: #444; font-size: .68rem; min-width: 1.8rem; padding-top: .15rem; }
    .ebody { flex: 1; min-width: 0; }
    .etext { font-size: .88rem; word-break: break-word; }
    .emeta { color: #555; font-size: .68rem; margin-top: .12rem; }
    .tag { display: inline-block; background: #222240; border-radius: 4px; font-size: .62rem; padding: .1rem .3rem; color: #8888cc; margin-right: .3rem; }
    .empty { color: #444; text-align: center; padding: .8rem 0; font-size: .82rem; }
    #loading { color: #555; font-size: .9rem; margin-top: 3rem; }
    #app { display: none; width: 100%; max-width: 560px; }
    .spin { display: inline-block; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="loading">⟳ Connecting to ToneZone…</div>

  <div id="app">
    <h1>ToneZone Store</h1>
    <p class="sub">Persistent text storage via MCP</p>

    <div class="card">
      <h2>Namespace</h2>
      <div class="row">
        <span class="ns-box" id="ns-display">—</span>
        <button class="ghost" id="copy-ns">Copy</button>
      </div>
      <p class="hint">This token is your storage key — share it to share access. Pass it to <code>open_store</code> to reopen this namespace later.</p>
    </div>

    <div class="card">
      <h2>Add Entry</h2>
      <div class="row">
        <input id="txt" placeholder="Text to store…" />
        <input id="lbl" placeholder="Label" style="max-width:100px" />
        <button id="store-btn">Save</button>
      </div>
      <div id="msg"></div>
    </div>

    <div class="card">
      <h2>Entries <button class="ghost" id="refresh-btn" style="margin-left:.4rem">Refresh</button></h2>
      <ul id="list"><li class="empty">No entries yet</li></ul>
    </div>
  </div>

  <script type="module">
    import { App } from 'https://esm.sh/@modelcontextprotocol/ext-apps';

    const app = new App({ name: 'ToneZone Store', version: '0.2.0' });
    let ns = null;

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function setMsg(t, cls = '') {
      const el = document.getElementById('msg');
      el.textContent = t; el.className = cls;
    }

    function renderEntries(entries) {
      const ul = document.getElementById('list');
      if (!entries || !entries.length) {
        ul.innerHTML = '<li class="empty">No entries yet — save something above!</li>';
        return;
      }
      ul.innerHTML = entries.map(e => \`
        <li>
          <span class="eid">#\${e.id}</span>
          <div class="ebody">
            \${e.label ? \`<span class="tag">\${esc(e.label)}</span>\` : ''}
            <span class="etext">\${esc(e.text)}</span>
            <div class="emeta">\${e.created_at} UTC</div>
          </div>
          <button class="del" data-id="\${e.id}">Del</button>
        </li>
      \`).join('');
      ul.querySelectorAll('.del').forEach(btn => {
        btn.addEventListener('click', () => deleteEntry(Number(btn.dataset.id)));
      });
    }

    async function refresh() {
      const btn = document.getElementById('refresh-btn');
      btn.disabled = true;
      try {
        const result = await app.callServerTool({ name: 'get_texts', arguments: { namespace: ns, limit: 50 } });
        const text = result.content?.find(c => c.type === 'text')?.text;
        renderEntries(JSON.parse(text));
      } finally {
        btn.disabled = false;
      }
    }

    async function storeText() {
      const text = document.getElementById('txt').value.trim();
      const label = document.getElementById('lbl').value.trim();
      if (!text) { setMsg('Text is required', 'err'); return; }
      const btn = document.getElementById('store-btn');
      btn.disabled = true; setMsg('Saving…');
      try {
        await app.callServerTool({ name: 'store_text', arguments: { namespace: ns, text, label: label || undefined } });
        document.getElementById('txt').value = '';
        document.getElementById('lbl').value = '';
        setMsg('Saved!', 'ok');
        await refresh();
      } catch (e) {
        setMsg(String(e), 'err');
      } finally {
        btn.disabled = false;
      }
    }

    async function deleteEntry(id) {
      await app.callServerTool({ name: 'delete_text', arguments: { namespace: ns, id } });
      await refresh();
    }

    // Receive initial data pushed by the host when the tool is called
    app.ontoolresult = (result) => {
      try {
        const text = result.content?.find(c => c.type === 'text')?.text;
        const data = JSON.parse(text);
        ns = data.namespace;
        document.getElementById('ns-display').textContent = ns;
        renderEntries(data.entries);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        document.getElementById('app').style.flexDirection = 'column';
        document.getElementById('app').style.alignItems = 'center';
      } catch (e) {
        document.getElementById('loading').textContent = 'Error: ' + e;
      }
    };

    app.connect();

    document.getElementById('store-btn').addEventListener('click', storeText);
    document.getElementById('refresh-btn').addEventListener('click', refresh);
    document.getElementById('copy-ns').addEventListener('click', () => navigator.clipboard.writeText(ns));
    document.getElementById('txt').addEventListener('keydown', e => { if (e.key === 'Enter') storeText(); });
  </script>
</body>
</html>`;

// ─── MCP handler ─────────────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: "open_store",
    description: "Open the ToneZone interactive text store UI. Returns a persistent storage interface where users can save, browse, and delete text entries. Optionally pass a namespace to reopen an existing store.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          description: "Namespace token to reopen an existing store. Omit to create a new one.",
        },
      },
    },
    _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
  },
  {
    name: "store_text",
    description: "Store a text entry under a namespace.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace token" },
        text: { type: "string", description: "The text to store" },
        label: { type: "string", description: "Optional label/category" },
      },
      required: ["namespace", "text"],
    },
  },
  {
    name: "get_texts",
    description: "Retrieve stored text entries for a namespace as a JSON array, newest first.",
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
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "tonezone-mcp", version: "0.3.0" },
      },
    };
  }

  if (method === "notifications/initialized") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }

  if (method === "resources/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resources: [
          {
            uri: APP_RESOURCE_URI,
            name: "ToneZone Store",
            mimeType: APP_MIME_TYPE,
            description: "Interactive persistent text store UI",
          },
        ],
      },
    };
  }

  if (method === "resources/read") {
    const uri = (params as { uri?: string })?.uri;
    if (uri === APP_RESOURCE_URI) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [{ uri: APP_RESOURCE_URI, mimeType: APP_MIME_TYPE, text: APP_HTML }],
        },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
  }

  if (method === "tools/call") {
    const toolName = (params as { name?: string })?.name;
    const args = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};
    const ns = sanitizeNs(args.namespace);

    try {
      if (toolName === "open_store") {
        const resolvedNs = args.namespace ? sanitizeNs(args.namespace) : generateNamespace();
        const entries = await getEntries(db, resolvedNs, 20);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ namespace: resolvedNs, entries }) }],
          },
        };
      }

      if (toolName === "store_text") {
        const text = args.text as string;
        if (!text) throw new Error("text is required");
        const entry = await storeEntry(db, ns, text, args.label as string | undefined);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Stored entry #${entry.id} in namespace "${ns}"` }],
          },
        };
      }

      if (toolName === "get_texts") {
        const limit = Math.min(Number(args.limit ?? 20), 100);
        const entries = await getEntries(db, ns, limit);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(entries) }] },
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
    <p class="hint">This token is your storage key — share it or pass it to <code>open_store</code> in a Claude chat to reopen your data.</p>
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
    <h2>Use in Claude</h2>
    <div class="mcp-info">Connect this MCP server in Claude, then say:

"Open my ToneZone store with namespace &lt;your-token&gt;"

Claude will call open_store and render the interactive UI
directly in the chat — no fetch() needed.</div>
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
      document.getElementById('ns-display').textContent = getNs();
    }

    function copyNs() { navigator.clipboard.writeText(getNs()); }

    function newNs() {
      if (!confirm('Generate a new namespace? You will lose access to the current one.')) return;
      localStorage.removeItem(NS_KEY);
      generateNs();
      renderNs();
      loadEntries();
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
          headers: { 'Content-Type': 'application/json' },
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
      } catch (e) { alert(String(e)); }
    }

    async function loadEntries() {
      try {
        const entries = await fetch(\`\${BASE}/api/entries?ns=\${encodeURIComponent(getNs())}\`).then(r => r.json());
        const ul = document.getElementById('entries');
        if (!entries.length) { ul.innerHTML = '<li class="empty">No entries yet — store something above!</li>'; return; }
        ul.innerHTML = entries.map(e => \`
          <li>
            <span class="entry-id">#\${e.id}</span>
            <div class="entry-body">
              \${e.label ? \`<span class="tag">\${esc(e.label)}</span>\` : ''}
              <span class="entry-text">\${esc(e.text)}</span>
              <div class="entry-meta">\${e.created_at} UTC</div>
            </div>
            <button class="small danger" onclick="deleteEntry(\${e.id})">Delete</button>
          </li>
        \`).join('');
      } catch (e) {
        document.getElementById('entries').innerHTML = \`<li class="empty" style="color:#ee4444">\${e}</li>\`;
      }
    }

    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    document.getElementById('text-input').addEventListener('keydown', e => { if (e.key === 'Enter') storeText(); });

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

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" && method === "GET") {
      return new Response(DEMO_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/entries" && method === "GET") {
      const ns = sanitizeNs(url.searchParams.get("ns"));
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
      const entries = await getEntries(env.DB, ns, limit);
      return jsonResponse(entries);
    }

    if (url.pathname === "/api/entries" && method === "POST") {
      let body: { namespace?: string; text?: string; label?: string };
      try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
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

    if (url.pathname === "/mcp" && method === "POST") {
      let body: JsonRpcRequest;
      try { body = await request.json(); } catch {
        return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      const response = await handleMcp(body, env.DB);
      return jsonResponse(response);
    }

    if (url.pathname === "/proxy" && method === "POST") {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...Object.fromEntries(
            [...request.headers.entries()].filter(([k]) =>
              ["authorization", "x-api-key", "anthropic-version", "anthropic-beta"].includes(k.toLowerCase())
            )
          ),
        },
        body: request.body,
      });
      const responseBody = await upstream.text();
      return new Response(responseBody, {
        status: upstream.status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
