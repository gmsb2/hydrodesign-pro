'use strict';

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const { CookieJar } = require('tough-cookie');
const { wrapper }   = require('axios-cookiejar-support');

const app  = express();
const PORT = process.env.PORT || 3001;
const SH   = 'https://www.supplyhouse.com';

// ── Persistent browser-like session to SupplyHouse.com ──────────────────
const jar = new CookieJar();
const sh  = wrapper(axios.create({
  jar,
  withCredentials: true,
  timeout: 14000,
  maxRedirects: 6,
  headers: {
    'User-Agent'       : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language'  : 'en-US,en;q=0.9',
    'Sec-Ch-Ua'        : '"Chromium";v="124", "Google Chrome";v="124"',
    'Sec-Ch-Ua-Mobile' : '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Site'   : 'same-origin',
    'Sec-Fetch-Mode'   : 'cors',
    'Sec-Fetch-Dest'   : 'empty',
  },
}));

let sessionUser   = null;  // { email, name, partyId }
let sessionCartId = null;

// ── Middleware ───────────────────────────────────────────────────────────
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));   // serves index.html at /

// ── Warm up: get homepage cookies before any real requests ───────────────
(async () => {
  try {
    await sh.get(SH, { headers: { Accept: 'text/html' } });
    console.log('  Session warm-up OK');
  } catch (_) { /* non-fatal */ }
})();

// ════════════════════════════════════════════════════════════════════════
//  GET /api/search?q=...&page=0
// ════════════════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
  const q    = (req.query.q    || '').trim();
  const page = Math.max(0, parseInt(req.query.page) || 0);
  if (!q) return res.json({ products: [], total: 0, page: 0 });

  const params = new URLSearchParams({
    SEARCH_STRING : q,
    searchTerm    : q,
    pageSize      : 20,
    viewIndex     : page * 20,
    sortType      : '',
    reorderFirst  : 'false',
  });

  try {
    const { data } = await sh.get(`${SH}/webapi/api/search?${params}`, {
      headers: {
        Accept  : 'application/json',
        Referer : `${SH}/search?searchTerm=${encodeURIComponent(q)}`,
      },
    });

    const products = normalizeProducts(data);
    const total    = data?.totalProductCount ?? data?.total ?? data?.numFound ?? products.length;
    res.json({ products, total, page });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(502).json({ error: `Search failed: ${err.message}` });
  }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/login   { email, password }
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

    const loginFailed = typeof data === 'string' && (
      data.includes('Incorrect email or password') ||
      data.includes('login_error') ||
      data.includes('There is no account') ||
      data.includes('Your email or password') ||
      data.includes('invalid credentials')
    );
    if (loginFailed) return res.status(401).json({ error: 'Invalid email or password' });

    sessionUser = { email };

    // Fetch profile for partyId + name
    try {
      const { data: profile } = await sh.get(`${SH}/webapi/party/profile`, {
        headers: { Accept: 'application/json' },
        validateStatus: s => s < 500,
      });
      if (profile?.partyId) {
        sessionUser.partyId = profile.partyId;
        sessionUser.name    = profile.firstName || profile.name || email;
        await initCart(profile.partyId);
      }
    } catch (_) { /* profile fetch optional */ }

    res.json({ success: true, user: { email, name: sessionUser.name || email } });
  } catch (err) {
    console.error('[login]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /api/status  — check whether session is still authenticated
// ════════════════════════════════════════════════════════════════════════
app.get('/api/status', async (req, res) => {
  if (!sessionUser) return res.json({ loggedIn: false });
  try {
    const { data } = await sh.get(`${SH}/webapi/party/profile`, {
      headers: { Accept: 'application/json' },
      validateStatus: s => s < 500,
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

// ════════════════════════════════════════════════════════════════════════
//  POST /api/logout
// ════════════════════════════════════════════════════════════════════════
app.post('/api/logout', async (req, res) => {
  try { await sh.get(`${SH}/sh/control/logout`); } catch (_) {}
  sessionUser   = null;
  sessionCartId = null;
  await jar.removeAllCookies();
  // Re-warm after logout
  try { await sh.get(SH, { headers: { Accept: 'text/html' } }); } catch (_) {}
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════
//  POST /api/cart/add   { productId, qty }
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
        { headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          validateStatus: s => s < 500 }
      );
      return res.json({ success: true, cartData: data });
    }

    // Fallback: classic form POST
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

// ════════════════════════════════════════════════════════════════════════
//  GET /api/cart  — item count only
// ════════════════════════════════════════════════════════════════════════
app.get('/api/cart', async (req, res) => {
  if (!sessionUser) return res.json({ count: 0 });
  try {
    const endpoint = sessionCartId
      ? `${SH}/webapi/api/cart/${sessionCartId}`
      : sessionUser.partyId
        ? `${SH}/webapi/cart/party/${sessionUser.partyId}`
        : null;
    if (!endpoint) return res.json({ count: 0 });

    const { data } = await sh.get(endpoint, {
      headers: { Accept: 'application/json' },
      validateStatus: s => s < 500,
    });
    if (data?.cartId && !sessionCartId) sessionCartId = data.cartId;
    const items = data?.items || data?.lineItems || data?.cartItems || data?.orderItems || [];
    res.json({ count: Array.isArray(items) ? items.length : 0 });
  } catch (_) {
    res.json({ count: 0 });
  }
});

// ════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════
async function initCart(partyId) {
  try {
    const { data } = await sh.get(`${SH}/webapi/cart/party/${partyId}`, {
      headers: { Accept: 'application/json' },
      validateStatus: s => s < 500,
    });
    sessionCartId = data?.cartId || data?.id || data?.shoppingCartId || null;
    if (!sessionCartId) {
      const { data: c } = await sh.post(`${SH}/webapi/cart/create/${partyId}`, null, {
        headers: { Accept: 'application/json' },
        validateStatus: s => s < 500,
      });
      sessionCartId = c?.cartId || c?.id || null;
    }
    if (sessionCartId) console.log('  Cart ID:', sessionCartId);
  } catch (e) {
    console.warn('[cart init]', e.message);
  }
}

function normalizeProducts(raw) {
  // Walk common API response shapes to find the products array
  const candidates = [
    raw?.products, raw?.data?.products,
    raw?.response?.docs, raw?.results,
    raw?.items, raw?.searchResults, raw?.hits,
    Array.isArray(raw) ? raw : null,
  ];
  const list = candidates.find(x => Array.isArray(x) && x.length > 0) || [];

  return list.slice(0, 20).map(p => {
    const price = parseFloat(
      p.price ?? p.salePrice ?? p.yourPrice ?? p.listPrice ?? p.priceValue ?? 0
    );
    let image = (
      p.imageUrl ?? p.thumbImage ?? p.thumb_image ?? p.thumbnailUrl ??
      p.smallImageUrl ?? p.image ?? ''
    ).replace(/^\/\//, 'https://');
    if (image && !image.startsWith('http')) image = `${SH}${image}`;

    let url = p.url ?? p.productUrl ?? p.pdpUrl ?? '';
    if (url && !url.startsWith('http')) url = `${SH}${url}`;

    return {
      id      : p.productId ?? p.pid ?? p.id ?? p.sku ?? p.partNumber ?? '',
      name    : p.name ?? p.title ?? p.productName ?? p.displayName ?? '',
      sku     : p.sku ?? p.partNumber ?? p.itemNumber ?? p.pid ?? p.productId ?? '',
      brand   : p.brand ?? p.manufacturer ?? p.brandName ?? '',
      price,
      listPrice: parseFloat(p.listPrice ?? p.originalPrice ?? price),
      image,
      url,
      inStock : p.inStock !== false && p.available !== false && p.availability !== 'OUT_OF_STOCK',
    };
  }).filter(p => p.name);
}

// ── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔥  HydroDesign Pro  →  http://localhost:${PORT}`);
  console.log('    SupplyHouse.com integration ready\n');
});
