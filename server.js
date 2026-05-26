'use strict';

const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const path       = require('path');
const Database   = require('better-sqlite3');
const { CookieJar } = require('tough-cookie');
const { wrapper }   = require('axios-cookiejar-support');

const app  = express();
const PORT = process.env.PORT || 3001;
const SH   = 'https://www.supplyhouse.com';

// ════════════════════════════════════════════════════════════════════════
//  LOCAL DATABASE  (SQLite, file: hydrodesign.db)
// ════════════════════════════════════════════════════════════════════════
const db = new Database(path.join(__dirname, 'hydrodesign.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    canvas_json TEXT NOT NULL DEFAULT '{"components":[],"connections":[]}',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS parts_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    project_name TEXT NOT NULL DEFAULT '',
    item_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    sku          TEXT DEFAULT '',
    brand        TEXT DEFAULT '',
    price        REAL DEFAULT 0,
    unit         TEXT DEFAULT 'ea',
    qty          REAL DEFAULT 1,
    source       TEXT DEFAULT 'local',
    added_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    sku         TEXT DEFAULT '',
    brand       TEXT DEFAULT '',
    price_paid  REAL DEFAULT 0,
    unit        TEXT DEFAULT 'ea',
    qty_on_hand REAL DEFAULT 0,
    location    TEXT DEFAULT '',
    notes       TEXT DEFAULT '',
    updated_at  TEXT DEFAULT (datetime('now'))
  );
`);

// Prepared statements
const stmts = {
  listProjects  : db.prepare('SELECT id, name, description, created_at, updated_at FROM projects ORDER BY updated_at DESC'),
  getProject    : db.prepare('SELECT * FROM projects WHERE id = ?'),
  insertProject : db.prepare('INSERT INTO projects (name, description, canvas_json) VALUES (?, ?, ?)'),
  updateProject : db.prepare('UPDATE projects SET name=?, description=?, canvas_json=?, updated_at=datetime(\'now\') WHERE id=?'),
  deleteProject : db.prepare('DELETE FROM projects WHERE id = ?'),

  insertPart    : db.prepare(`INSERT INTO parts_history
    (project_id, project_name, item_id, name, sku, brand, price, unit, qty, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  partsByProject: db.prepare('SELECT * FROM parts_history WHERE project_id = ? ORDER BY added_at'),
  allParts      : db.prepare('SELECT * FROM parts_history ORDER BY added_at DESC'),
  deleteProjParts: db.prepare('DELETE FROM parts_history WHERE project_id = ?'),

  listInv       : db.prepare('SELECT * FROM inventory ORDER BY name'),
  upsertInv     : db.prepare(`INSERT INTO inventory (item_id, name, sku, brand, price_paid, unit, qty_on_hand, location, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      name=excluded.name, sku=excluded.sku, brand=excluded.brand,
      price_paid=excluded.price_paid, unit=excluded.unit,
      qty_on_hand=excluded.qty_on_hand, location=excluded.location,
      notes=excluded.notes, updated_at=datetime('now')`),
  updateInvQty  : db.prepare('UPDATE inventory SET qty_on_hand=?, updated_at=datetime(\'now\') WHERE id=?'),
  deleteInv     : db.prepare('DELETE FROM inventory WHERE id = ?'),
};

// ════════════════════════════════════════════════════════════════════════
//  SUPPLYHOUSE.COM HTTP CLIENT
// ════════════════════════════════════════════════════════════════════════
const jar = new CookieJar();
const sh  = wrapper(axios.create({
  jar,
  withCredentials: true,
  timeout: 14000,
  maxRedirects: 6,
  headers: {
    'User-Agent'        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language'   : 'en-US,en;q=0.9',
    'Sec-Ch-Ua'         : '"Chromium";v="124", "Google Chrome";v="124"',
    'Sec-Ch-Ua-Mobile'  : '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Site'    : 'same-origin',
    'Sec-Fetch-Mode'    : 'cors',
    'Sec-Fetch-Dest'    : 'empty',
  },
}));

let sessionUser   = null;
let sessionCartId = null;

// Warm up session cookies on startup
(async () => {
  try {
    await sh.get(SH, { headers: { Accept: 'text/html' } });
    console.log('  SupplyHouse session warm-up OK');
  } catch (_) {}
})();

// ════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════
app.use(cors({ origin: true }));
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ════════════════════════════════════════════════════════════════════════
//  SEARCH  GET /api/search?q=...&page=0
// ════════════════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
  const q    = (req.query.q    || '').trim();
  const page = Math.max(0, parseInt(req.query.page) || 0);
  if (!q) return res.json({ products: [], total: 0, page: 0 });

  try {
    const result = await shSearch(q, page);
    res.json(result);
  } catch (err) {
    console.error('[search]', err.message);
    res.status(502).json({ error: `Search failed: ${err.message}` });
  }
});

// Core search logic — handles redirects automatically
async function shSearch(q, page = 0) {
  const params = new URLSearchParams({
    SEARCH_STRING : q,
    searchTerm    : q,
    pageSize      : 20,
    viewIndex     : page * 20,
    sortType      : '',
    reorderFirst  : 'false',
  });

  const { data } = await sh.get(`${SH}/webapi/api/search?${params}`, {
    headers: { Accept: 'application/json', Referer: `${SH}/search?searchTerm=${encodeURIComponent(q)}` },
  });

  const type = data?.type;

  // ── Direct results (most common) ──────────────────────────────────────
  if (!type || type === 'navigation' || type === 'productList') {
    return { products: normalizeProducts(data), total: data?.totalProductNum ?? 0, page };
  }

  // ── Single product redirect (productRedirect) ─────────────────────────
  if (type === 'productRedirect' && data?.productId) {
    const single = await fetchSingleProduct(data.productId);
    return { products: single ? [single] : [], total: single ? 1 : 0, page, hint: 'Exact match' };
  }

  // ── Category/brand redirect ────────────────────────────────────────────
  if (type === 'redirect' && data?.kwRedirect) {
    // Extract the human-readable slug from the redirect path, strip trailing ID
    const slug = data.kwRedirect.replace(/^\//, '').replace(/-\d+$/, '').replace(/-/g, ' ');
    // Retry with slug as search term (avoids brand-name exact-match redirect)
    const retryParams = new URLSearchParams({
      SEARCH_STRING : slug,
      searchTerm    : slug,
      pageSize      : 20,
      viewIndex     : page * 20,
      sortType      : '',
      reorderFirst  : 'false',
    });
    const retry = await sh.get(`${SH}/webapi/api/search?${retryParams}`, {
      headers: { Accept: 'application/json', Referer: `${SH}${data.kwRedirect}` },
    });
    const retryData = retry.data;
    if (retryData?.products?.length) {
      return { products: normalizeProducts(retryData), total: retryData?.totalProductNum ?? 0, page, hint: `Showing: ${slug}` };
    }
    // Last resort: search with original query + "product" suffix
    const fallbackParams = new URLSearchParams({
      SEARCH_STRING : `${q} product`,
      searchTerm    : `${q} product`,
      pageSize      : 20, viewIndex: 0, sortType: '', reorderFirst: 'false',
    });
    const fallback = await sh.get(`${SH}/webapi/api/search?${fallbackParams}`, {
      headers: { Accept: 'application/json' },
    });
    return {
      products: normalizeProducts(fallback.data),
      total: fallback.data?.totalProductNum ?? 0,
      page,
      hint: `Redirected from: ${q}`,
    };
  }

  // ── Keyword redirect with products (hardcodedCategory) ───────────────
  if (data?.products?.length) {
    return { products: normalizeProducts(data), total: data?.totalProductNum ?? data.products.length, page };
  }

  return { products: [], total: 0, page, hint: `No results for "${q}" — try a more specific term` };
}

// Fetch a single product by its prodId
async function fetchSingleProduct(prodId) {
  try {
    const { data } = await sh.get(`${SH}/webapi/api/product/${prodId}`, {
      headers: { Accept: 'application/json' },
      validateStatus: s => s < 500,
    });
    if (!data?.productInfo) return null;
    return normalizeProduct(data);
  } catch (_) { return null; }
}

// ════════════════════════════════════════════════════════════════════════
//  NORMALIZE  SupplyHouse product → our standard shape
// ════════════════════════════════════════════════════════════════════════
function normalizeProducts(raw) {
  const list = raw?.products;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map(normalizeProduct).filter(p => p?.name);
}

function normalizeProduct(p) {
  if (!p) return null;
  const pi  = p.productInfo  || {};
  const pp  = p.productPrice || {};
  const inv = p.inventory    || {};

  const defaultPrice = pp.DEFAULT?.defaultPrice?.price ?? pp.BOX?.defaultPrice?.price ?? 0;
  const listPrice    = pp.COMPARE_DEFAULT?.defaultPrice?.price ?? 0;

  const imgs  = pi.productImages || [];
  const img   = imgs[0]?.smallImage || imgs[0]?.largeImage || '';
  const image = img ? `${SH}${img}` : '';
  const url   = pi.url ? `${SH}/${pi.url}` : '';

  return {
    id      : p.prodId || pi.productId || '',
    name    : pi.productName || pi.productShortName || pi.internalName || '',
    sku     : p.prodId || pi.productId || '',
    brand   : pi.brandName || pi.brand?.categoryName || '',
    price   : parseFloat(defaultPrice) || 0,
    listPrice: parseFloat(listPrice) || 0,
    image,
    url,
    inStock : inv.inStock !== false,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  LOGIN / LOGOUT / STATUS
// ════════════════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const body = new URLSearchParams({
    USERNAME           : email,
    PASSWORD           : password,
    TARGET             : '/',
    'system-timestamp' : String(Date.now()),
    'visitor-tz'       : 'America/New_York',
  });

  try {
    const { data } = await sh.post(`${SH}/sh/control/login`, body.toString(), {
      headers: {
        'Content-Type' : 'application/x-www-form-urlencoded',
        Accept         : 'text/html,application/xhtml+xml,*/*',
        Referer        : `${SH}/login`,
      },
      validateStatus: s => s < 500,
    });

    if (typeof data === 'string' && (
      data.includes('Incorrect email or password') ||
      data.includes('There is no account') ||
      data.includes('Your email or password')
    )) return res.status(401).json({ error: 'Invalid email or password' });

    sessionUser = { email };

    try {
      const { data: profile } = await sh.get(`${SH}/webapi/party/profile`, {
        headers: { Accept: 'application/json' }, validateStatus: s => s < 500,
      });
      if (profile?.partyId) {
        sessionUser.partyId = profile.partyId;
        sessionUser.name    = profile.firstName || profile.name || email;
        await initCart(profile.partyId);
      }
    } catch (_) {}

    res.json({ success: true, user: { email, name: sessionUser.name || email } });
  } catch (err) {
    console.error('[login]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  if (!sessionUser) return res.json({ loggedIn: false });
  try {
    const { data } = await sh.get(`${SH}/webapi/party/profile`, {
      headers: { Accept: 'application/json' }, validateStatus: s => s < 500,
    });
    if (data?.partyId || data?.email) {
      sessionUser.partyId = data.partyId || sessionUser.partyId;
      sessionUser.name    = data.firstName || sessionUser.name || sessionUser.email;
      return res.json({ loggedIn: true, user: { email: sessionUser.email, name: sessionUser.name } });
    }
  } catch (_) {}
  sessionUser = null;
  res.json({ loggedIn: false });
});

app.post('/api/logout', async (req, res) => {
  try { await sh.get(`${SH}/sh/control/logout`); } catch (_) {}
  sessionUser = null; sessionCartId = null;
  await jar.removeAllCookies();
  try { await sh.get(SH, { headers: { Accept: 'text/html' } }); } catch (_) {}
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════
//  CART
// ════════════════════════════════════════════════════════════════════════
app.post('/api/cart/add', async (req, res) => {
  const { productId, qty = 1 } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId required' });
  if (!sessionUser) return res.status(401).json({ error: 'Login required' });

  try {
    if (!sessionCartId && sessionUser.partyId) await initCart(sessionUser.partyId);

    if (sessionCartId) {
      const { data } = await sh.post(
        `${SH}/webapi/api/cart/${sessionCartId}/set/${productId}:${qty}`,
        null,
        { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, validateStatus: s => s < 500 }
      );
      return res.json({ success: true, cartData: data });
    }
    // Fallback form post
    await sh.post(`${SH}/sh/control/main`,
      new URLSearchParams({ add_product_id: productId, product_id: productId, quantity: qty, VIEW: 'main' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: s => s < 500 }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[cart/add]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/cart', async (req, res) => {
  if (!sessionUser) return res.json({ count: 0 });
  try {
    const endpoint = sessionCartId
      ? `${SH}/webapi/api/cart/${sessionCartId}`
      : sessionUser.partyId ? `${SH}/webapi/cart/party/${sessionUser.partyId}` : null;
    if (!endpoint) return res.json({ count: 0 });
    const { data } = await sh.get(endpoint, { headers: { Accept: 'application/json' }, validateStatus: s => s < 500 });
    if (data?.cartId && !sessionCartId) sessionCartId = data.cartId;
    const items = data?.items || data?.lineItems || data?.cartItems || [];
    res.json({ count: Array.isArray(items) ? items.length : 0 });
  } catch (_) { res.json({ count: 0 }); }
});

async function initCart(partyId) {
  try {
    const { data } = await sh.get(`${SH}/webapi/cart/party/${partyId}`, {
      headers: { Accept: 'application/json' }, validateStatus: s => s < 500,
    });
    sessionCartId = data?.cartId || data?.id || null;
    if (!sessionCartId) {
      const { data: c } = await sh.post(`${SH}/webapi/cart/create/${partyId}`, null, {
        headers: { Accept: 'application/json' }, validateStatus: s => s < 500,
      });
      sessionCartId = c?.cartId || c?.id || null;
    }
  } catch (e) { console.warn('[cart init]', e.message); }
}

// ════════════════════════════════════════════════════════════════════════
//  DATABASE — PROJECTS
// ════════════════════════════════════════════════════════════════════════
app.get('/api/db/projects', (req, res) => {
  res.json(stmts.listProjects.all());
});

app.post('/api/db/projects', (req, res) => {
  const { name, description = '', canvas_json, parts = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const canvasStr = typeof canvas_json === 'string' ? canvas_json : JSON.stringify(canvas_json || {});
  const info = stmts.insertProject.run(name.trim(), description, canvasStr);
  const projectId = info.lastInsertRowid;

  // Insert parts history
  const insertParts = db.transaction((rows, pname) => {
    stmts.deleteProjParts.run(projectId);
    for (const p of rows) {
      stmts.insertPart.run(projectId, pname, p.item_id||p.id||'', p.name||'', p.sku||'', p.brand||'', p.price||0, p.unit||'ea', p.qty||1, p.source||'local');
    }
  });
  insertParts(parts, name);

  res.json({ id: projectId, name, created_at: new Date().toISOString() });
});

app.get('/api/db/projects/:id', (req, res) => {
  const project = stmts.getProject.get(Number(req.params.id));
  if (!project) return res.status(404).json({ error: 'Not found' });
  const parts = stmts.partsByProject.all(project.id);
  res.json({ ...project, parts });
});

app.put('/api/db/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = stmts.getProject.get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, description, canvas_json, parts } = req.body;
  const canvasStr = canvas_json ? (typeof canvas_json === 'string' ? canvas_json : JSON.stringify(canvas_json)) : existing.canvas_json;

  stmts.updateProject.run(name || existing.name, description ?? existing.description, canvasStr, id);

  if (Array.isArray(parts)) {
    const updateParts = db.transaction((rows, pname) => {
      stmts.deleteProjParts.run(id);
      for (const p of rows) {
        stmts.insertPart.run(id, pname, p.item_id||p.id||'', p.name||'', p.sku||'', p.brand||'', p.price||0, p.unit||'ea', p.qty||1, p.source||'local');
      }
    });
    updateParts(parts, name || existing.name);
  }

  res.json({ success: true });
});

app.delete('/api/db/projects/:id', (req, res) => {
  stmts.deleteProject.run(Number(req.params.id));
  res.json({ success: true });
});

// ── Parts history (across all projects) ─────────────────────────────────
app.get('/api/db/parts-history', (req, res) => {
  res.json(stmts.allParts.all());
});

// ════════════════════════════════════════════════════════════════════════
//  DATABASE — INVENTORY
// ════════════════════════════════════════════════════════════════════════
app.get('/api/db/inventory', (req, res) => {
  res.json(stmts.listInv.all());
});

app.post('/api/db/inventory', (req, res) => {
  const { item_id, name, sku='', brand='', price_paid=0, unit='ea', qty_on_hand=0, location='', notes='' } = req.body;
  if (!item_id || !name) return res.status(400).json({ error: 'item_id and name required' });
  stmts.upsertInv.run(item_id, name, sku, brand, price_paid, unit, qty_on_hand, location, notes);
  res.json({ success: true });
});

app.put('/api/db/inventory/:id', (req, res) => {
  const { qty_on_hand } = req.body;
  if (qty_on_hand == null) return res.status(400).json({ error: 'qty_on_hand required' });
  stmts.updateInvQty.run(qty_on_hand, Number(req.params.id));
  res.json({ success: true });
});

app.delete('/api/db/inventory/:id', (req, res) => {
  stmts.deleteInv.run(Number(req.params.id));
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🔥  HydroDesign Pro  →  http://localhost:${PORT}`);
  console.log(`    DB: ${path.join(__dirname, 'hydrodesign.db')}\n`);
});
