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

export async function fetchPricesForGame(appid, delayMs = 500) {
  // Marché COMPLET du jeu (cartes + fonds d'écran + emoticônes) — sans filtre item_class.
  // Permet de valoriser les récompenses de craft et le grind en gemmes.
  // Steam renvoie ~10 résultats/appel quelle que soit la valeur de count → on pagine.
  const all = [];
  let start = 0;
  let guard = 0;
  while (guard++ < 60) {
    const url = `${BASE}/market/search/render/?appid=753&start=${start}&count=100`
      + `&category_753_Game%5B%5D=tag_app_${appid}`
      + `&norender=1`;
    const res = await steamFetch(url);
    const d = await res.json();
    if (!d.results || !d.results.length) break;
    for (const c of d.results) {
      all.push({
        mhn: c.hash_name,
        instant_buy_cents: c.sell_price,
        type: c.asset_description?.type || '',
      });
    }
    start += d.results.length;
    if (start >= (d.total_count || 0)) break;
    await sleep(delayMs);
  }
  return all;
}

// ── Carnet d'ordres : nameid + histogramme (bid/ask réels) ────────────────────

// item_nameid : identifiant interne du carnet d'ordres d'un item, immuable.
// Récupéré une fois depuis la page listing puis caché à vie côté storage.
export async function fetchItemNameId(mhn) {
  const res = await steamFetch(`${BASE}/market/listings/753/${encodeURIComponent(mhn)}`);
  const html = await res.text();
  const m = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/);
  if (!m) throw new Error(`nameid introuvable pour ${mhn}`);
  return m[1];
}

// Histogramme du carnet : highest_buy_order = ce que paie le meilleur acheteur
// (= prix d'instant sell), lowest_sell_order = ask le plus bas (= instant buy).
// ⚠ endpoint rate-limité (~20/min) : espacer les appels de ≥3s.
export async function directGetJson(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

export async function fetchHistogram(nameid, getJson = directGetJson) {
  const url = `${BASE}/market/itemordershistogram?country=FR&language=english&currency=3&item_nameid=${nameid}&two_factor=0`;
  const d = await getJson(url);
  return {
    bid: parseInt(d.highest_buy_order || '0', 10) || 0,
    ask: parseInt(d.lowest_sell_order || '0', 10) || 0,
  };
}

// ── Transport POST ────────────────────────────────────────────────────────────
// Steam rejette (HTTP 406) les POST marché émis depuis le contexte extension
// (Origin chrome-extension://, Referer absent — en-têtes impossibles à poser sur
// fetch). Les fonctions ci-dessous acceptent donc un `post(url, fields)` injecté
// par le service worker, qui exécute la requête DANS un onglet steamcommunity
// (en-têtes de page authentiques). Repli : POST direct urlencoded.

export async function directPost(url, fields) {
  const res = await fetch(url, { method: 'POST', credentials: 'include', body: new URLSearchParams(fields) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

// ── Listing à la vente ────────────────────────────────────────────────────────

export async function sellItem({ sessionid, assetid, priceNet }, post = directPost) {
  return post(`${BASE}/market/sellitem/`, {
    sessionid,
    appid: '753',
    contextid: '6',
    assetid: String(assetid),
    amount: '1',
    price: String(priceNet),
  });
}

// ── Créer un buy order ────────────────────────────────────────────────────────

export async function createBuyOrder({ sessionid, mhn, priceTotal, quantity = 1, confirmation = '' }, post = directPost) {
  // Payload minimal de SIH : AUCUNE adresse. Steam ne réclame pas la facturation,
  // il réclame une CONFIRMATION mobile (réponse need_confirmation / success:22),
  // gérée séparément via steam-confirm.js. `confirmation` = id rejoué après accept.
  const fields = {
    sessionid,
    currency: '3',
    appid: '753',
    market_hash_name: mhn,
    price_total: String(priceTotal),
    quantity: String(quantity),
    billing_state: '',
    save_my_address: '0',
  };
  if (confirmation) fields.confirmation = String(confirmation);
  return post(`${BASE}/market/createbuyorder/`, fields);
}

// ── Crafter un badge ──────────────────────────────────────────────────────────

export async function craftBadge({ sessionid, steamid, appid, foil = false }, post = directPost) {
  return post(`${BASE}/profiles/${steamid}/ajaxcraftbadge/`, {
    sessionid,
    appid: String(appid),
    series: '1',
    border_color: foil ? '1' : '0',
  });
}

// ── Gems : valeur d'un item ───────────────────────────────────────────────────

export async function getGooValue({ sessionid, steamid, sourceAppid, assetid }, getJson = directGetJson) {
  const url = `${BASE}/profiles/${steamid}/ajaxgetgoovalue/`
    + `?sessionid=${sessionid}&appid=${sourceAppid}&assetid=${assetid}&contextid=6&item_type=2&border_color=0`;
  return getJson(url);
}

// ── Grinder un item en gems ───────────────────────────────────────────────────

export async function grindIntoGoo({ sessionid, steamid, sourceAppid, assetid, gooValueExpected }, post = directPost) {
  return post(`${BASE}/profiles/${steamid}/ajaxgrindintogoo/`, {
    sessionid,
    appid: String(sourceAppid),
    assetid: String(assetid),
    contextid: '6',
    goo_value_expected: String(gooValueExpected),
  });
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
