// Wrappers des endpoints Steam

const BASE = 'https://steamcommunity.com';

async function steamFetch(url, opts = {}) {
  const res = await fetch(url, { credentials: 'include', ...opts });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res;
}

// ── Inventaire ────────────────────────────────────────────────────────────────

export async function fetchInventory(steamid) {
  // Steam plafonne count à 2000 — au-delà renvoie HTTP 400.
  // On pagine via more_items / last_assetid pour les gros inventaires.
  let assets = [];
  let descriptions = [];
  let url = `${BASE}/inventory/${steamid}/753/6?l=english&count=2000`;
  let guard = 0;

  while (url && guard++ < 25) {
    const res = await steamFetch(url);
    const j = await res.json();
    if (j.assets) assets = assets.concat(j.assets);
    if (j.descriptions) descriptions = descriptions.concat(j.descriptions);

    if (j.more_items && j.last_assetid) {
      url = `${BASE}/inventory/${steamid}/753/6?l=english&count=2000&start_assetid=${j.last_assetid}`;
      await sleep(800); // évite le rate limit entre pages
    } else {
      url = null;
    }
  }

  return { success: 1, assets, descriptions, total_inventory_count: assets.length };
}

// ── Page badge (HTML) ─────────────────────────────────────────────────────────

export async function fetchBadgePage(steamid, appid, foil = false) {
  let url = `${BASE}/profiles/${steamid}/gamecards/${appid}/?l=english`;
  if (foil) url += '&border=1';
  const res = await steamFetch(url);
  return res.text();
}

// ── Prix marché (paginé, non rate-limited) ────────────────────────────────────

export async function fetchPricesForGame(appid, delayMs = 1000) {
  const all = [];
  let start = 0;
  while (true) {
    const url = `${BASE}/market/search/render/?appid=753&start=${start}&count=100`
      + `&category_753_Game%5B%5D=tag_app_${appid}`
      + `&category_753_item_class%5B%5D=tag_item_class_2`
      + `&norender=1`;
    const res = await steamFetch(url);
    const d = await res.json();
    if (!d.results || !d.results.length) break;
    for (const c of d.results) {
      all.push({
        mhn: c.hash_name,
        instant_buy_cents: c.sell_price,
        instant_sell_cents: c.sell_price_no_fee || c.sell_price,
        highest_buy_order_text: c.sale_price_text,
      });
    }
    start += d.results.length;
    if (start >= d.total_count) break;
    await sleep(delayMs);
  }
  return all;
}

// ── Listing à la vente ────────────────────────────────────────────────────────

export async function sellItem({ sessionid, steamid, assetid, priceNet }) {
  const fd = new FormData();
  fd.append('sessionid', sessionid);
  fd.append('appid', '753');
  fd.append('contextid', '6');
  fd.append('assetid', assetid);
  fd.append('amount', '1');
  fd.append('price', String(priceNet));
  const res = await steamFetch(`${BASE}/market/sellitem/`, {
    method: 'POST',
    headers: {
      'Referer': `${BASE}/profiles/${steamid}/inventory/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: fd,
  });
  return res.json();
}

// ── Créer un buy order ────────────────────────────────────────────────────────

export async function createBuyOrder({ sessionid, mhn, priceTotal, billing }) {
  const fd = new FormData();
  fd.append('sessionid', sessionid);
  fd.append('currency', '3');
  fd.append('appid', '753');
  fd.append('market_hash_name', mhn);
  fd.append('price_total', String(priceTotal));
  fd.append('quantity', '1');
  // Billing fields (required — sans eux Steam retourne success:22)
  fd.append('billing_address', billing.billing_address || '');
  fd.append('billing_address_two', '');
  fd.append('billing_city', billing.billing_city || '');
  fd.append('billing_country', billing.billing_country || 'FR');
  fd.append('billing_po', billing.billing_po || '');
  fd.append('billing_state', billing.billing_state || '');
  fd.append('first_name', billing.first_name || '');
  fd.append('last_name', billing.last_name || '');
  fd.append('tradefee_tax', '0');
  const res = await steamFetch(`${BASE}/market/createbuyorder/`, {
    method: 'POST',
    headers: {
      'Referer': `${BASE}/market/listings/753/${encodeURIComponent(mhn)}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: fd,
  });
  return res.json();
}

// ── Crafter un badge ──────────────────────────────────────────────────────────

export async function craftBadge({ sessionid, steamid, appid, foil = false }) {
  const fd = new FormData();
  fd.append('sessionid', sessionid);
  fd.append('appid', String(appid));
  fd.append('series', '1');
  fd.append('border_color', foil ? '1' : '0');
  const res = await steamFetch(`${BASE}/profiles/${steamid}/ajaxcraftbadge/`, {
    method: 'POST',
    headers: {
      'Referer': `${BASE}/profiles/${steamid}/gamecards/${appid}/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: fd,
  });
  return res.json();
}

// ── Gems : valeur d'un item ───────────────────────────────────────────────────

export async function getGooValue({ sessionid, steamid, sourceAppid, assetid }) {
  const url = `${BASE}/profiles/${steamid}/ajaxgetgoovalue/`
    + `?sessionid=${sessionid}&appid=${sourceAppid}&assetid=${assetid}&contextid=6&item_type=2&border_color=0`;
  const res = await steamFetch(url);
  return res.json();
}

// ── Grinder un item en gems ───────────────────────────────────────────────────

export async function grindIntoGoo({ sessionid, steamid, sourceAppid, assetid, gooValueExpected }) {
  const fd = new FormData();
  fd.append('sessionid', sessionid);
  fd.append('appid', String(sourceAppid));
  fd.append('assetid', assetid);
  fd.append('contextid', '6');
  fd.append('goo_value_expected', String(gooValueExpected));
  const res = await steamFetch(`${BASE}/profiles/${steamid}/ajaxgrindintogoo/`, {
    method: 'POST',
    headers: {
      'Referer': `${BASE}/profiles/${steamid}/inventory/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: fd,
  });
  return res.json();
}

// ── Wallet Steam (via profil) ─────────────────────────────────────────────────

export async function fetchWallet(steamid) {
  // Pas d'endpoint API direct — on parse la page du marché
  const res = await steamFetch(`${BASE}/market/`);
  const html = await res.text();
  const m = html.match(/var g_rgWalletInfo\s*=\s*({.*?});/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) { return null; }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
