import { getSession, setSession, getBilling, setBilling, getPlan, setPlan, getQueue, setQueue, getSettings, getPriceCache, setPriceCache, getNameIds, setNameIds, getReport, setReport } from '../lib/storage.js';
import { fetchInventory, fetchBadgePage, fetchPricesForGame, fetchItemNameId, fetchHistogram, sellItem, createBuyOrder, craftBadge, getGooValue, grindIntoGoo, fetchWallet, sleep } from '../lib/steam-api.js';
import { parseInventory, getGrindableItems } from '../lib/inventory.js';
import { parseBadgePage } from '../lib/badges.js';
import { buildPriceMap, sellerReceivesForBuyerPays } from '../lib/pricing.js';
import { buildPlan, expandSellQueue, expandBuyQueue, expandCraftQueue } from '../lib/optimizer.js';

// ── Transport via onglet Steam ────────────────────────────────────────────────
// Steam répond HTTP 406 aux POST marché émis depuis le contexte extension
// (Origin chrome-extension://, Referer absent — en-têtes non modifiables sur
// fetch). Vérifié en réel : la MÊME requête passe depuis une page Steam.
// → on exécute donc les appels sensibles DANS un onglet steamcommunity,
//   ouvert en arrière-plan si aucun n'existe.

async function getSteamTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://steamcommunity.com/*' });
  let tab = tabs.find(t => t.status === 'complete') || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://steamcommunity.com/market/', active: false });
  }
  for (let i = 0; i < 40; i++) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === 'complete') return t.id;
    } catch (_) { throw new Error('Onglet Steam fermé pendant l\'opération.'); }
    await sleep(250);
  }
  return tab.id;
}

// Exécute un fetch même-origine depuis l'onglet Steam (en-têtes de page parfaits).
async function tabFetch(url, fields = null) {
  const tabId = await getSteamTabId();
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url, fields) => {
      try {
        const opts = { credentials: 'include' };
        if (fields) { opts.method = 'POST'; opts.body = new URLSearchParams(fields); }
        const res = await fetch(url, opts);
        const text = await res.text();
        try { return { status: res.status, json: JSON.parse(text) }; }
        catch (_) { return { status: res.status, text: text.slice(0, 300) }; }
      } catch (e) { return { status: 0, error: String(e) }; }
    },
    args: [url, fields],
  });
  const out = r && r.result;
  if (!out) throw new Error('Exécution dans l\'onglet Steam impossible.');
  if (out.error) throw new Error(out.error);
  if (out.json) return out.json;
  throw Object.assign(new Error(`HTTP ${out.status}${out.text ? ' — ' + out.text.slice(0, 80) : ''}`), { status: out.status });
}

const pagePost = (url, fields) => tabFetch(url, fields);
const pageGet  = (url) => tabFetch(url, null);

// ── État d'exécution ──────────────────────────────────────────────────────────

let running = false;
let paused = false;
let currentPhase = null;
let progress = { done: 0, total: 0, lastAction: '' };

function pauseAll()  { paused = true; }
function resumeAll() { paused = false; }
function stopAll()   { paused = false; running = false; }

async function waitIfPaused() {
  while (paused && running) await sleep(500);
}

function notify(id, title, message) {
  try {
    chrome.notifications.create(id, { type: 'basic', iconUrl: '../icons/icon48.png', title, message });
  } catch (_) {}
}

// ── Messages ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STEAM_SESSION') {
    setSession({ sessionid: msg.sessionid, steamid: msg.steamid, vanity: msg.vanity, profileType: msg.profileType });
    return false;
  }
  if (msg.type === 'BILLING_CAPTURED') {
    getBilling().then(existing => {
      if (!isBillingComplete(msg.billing)) return; // jamais stocker une capture partielle
      if (!isBillingComplete(existing)) {
        setBilling(msg.billing);
        notify('billing_captured', 'Steam Badge Optimizer', 'Infos de facturation capturées ✓');
      }
    });
    return false;
  }

  switch (msg.type) {
    case 'ANALYZE':
      handleAnalyze().then(sendResponse).catch(e => {
        running = false; currentPhase = null;
        sendResponse({ error: e.message });
      });
      return true;
    case 'RUN_PHASE1':
      runPhase1().then(sendResponse).catch(e => { running = false; currentPhase = null; sendResponse({ error: e.message }); });
      return true;
    case 'RUN_PHASE2':
      runPhase2().then(sendResponse).catch(e => { running = false; currentPhase = null; sendResponse({ error: e.message }); });
      return true;
    case 'RUN_GEMS':
      runGems().then(sendResponse).catch(e => { running = false; currentPhase = null; sendResponse({ error: e.message }); });
      return true;
    case 'GET_STATUS':
      getStatus().then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    case 'PAUSE':  pauseAll();  sendResponse({ ok: true }); return false;
    case 'RESUME': resumeAll(); sendResponse({ ok: true }); return false;
    case 'STOP':   stopAll();   sendResponse({ ok: true }); return false;
  }
});

// Un billing incomplet est inutilisable : Steam répond success:22 sur createbuyorder.
function isBillingComplete(b) {
  return !!(b && b.first_name && b.last_name && b.billing_address
    && b.billing_city && b.billing_country && (b.billing_po || b.billing_postal_code));
}

async function getStatus() {
  const session = await resolveSession();
  let billing = await getBilling();
  // Purge une éventuelle capture partielle héritée des versions précédentes
  if (billing && !isBillingComplete(billing)) { await setBilling(null); billing = null; }
  const plan = await getPlan();
  const report = await getReport();
  if (!billing) ensureBridgeInSteamTabs(); // capture DOM de l'adresse si un onglet marché est ouvert
  return { running, paused, currentPhase, progress, hasSession: !!session.sessionid, hasBilling: !!billing, plan, report };
}

// ── Session : cookies d'abord (fiable), content script en secours ─────────────

async function getSessionFromCookies() {
  try {
    const sc = await chrome.cookies.get({ url: 'https://steamcommunity.com', name: 'sessionid' });
    if (!sc || !sc.value) return null;
    let steamid = '';
    const lc = await chrome.cookies.get({ url: 'https://steamcommunity.com', name: 'steamLoginSecure' });
    if (lc && lc.value) {
      const m = decodeURIComponent(lc.value).match(/^(\d{17})/);
      if (m) steamid = m[1];
    }
    return { sessionid: sc.value, steamid };
  } catch (_) { return null; }
}

async function resolveSession() {
  const fromCookies = await getSessionFromCookies();
  if (fromCookies && fromCookies.sessionid && fromCookies.steamid) {
    const stored = await getSession();
    const merged = { ...stored, ...fromCookies };
    await setSession(merged);
    return merged;
  }
  const stored = await getSession();
  if (stored && stored.sessionid && stored.steamid) return stored;
  return (await tryInjectIntoSteamTabs()) || stored || {};
}

let lastBridgeInject = 0;
async function ensureBridgeInSteamTabs() {
  const now = Date.now();
  if (now - lastBridgeInject < 8000) return;
  lastBridgeInject = now;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://steamcommunity.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/steam-bridge-main.js'], world: 'MAIN' });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/steam-bridge.js'] });
      } catch (_) {}
    }
  } catch (_) {}
}

async function tryInjectIntoSteamTabs() {
  await ensureBridgeInSteamTabs();
  await sleep(400);
  const s = await getSession();
  return s && s.sessionid ? s : null;
}

// ── ANALYSE : un seul algorithme (max XP) ─────────────────────────────────────

async function handleAnalyze() {
  const session = await resolveSession();
  if (!session.steamid) throw new Error('Pas de session Steam détectée. Ouvre steamcommunity.com d\'abord.');

  const settings = await getSettings();
  const PRICE_TTL = 6 * 3600 * 1000;
  const BADGE_DELAY = 350;

  running = true; paused = false; currentPhase = 'analyze';
  progress = { done: 0, total: 0, lastAction: 'Récupération de l\'inventaire…' };

  // 1. Inventaire
  const rawInv = await fetchInventory(session.steamid);
  const inv = parseInventory(rawInv);

  // Jeux avec cartes uniquement
  const exclude = new Set((settings.excludeAppids || []).map(String));
  const appids = Object.keys(inv.byApp).filter(a => {
    if (exclude.has(String(a))) return false;
    const g = inv.byApp[a];
    return g.cards.length > 0 || (settings.includeFoils && g.foilCards.length > 0);
  });

  progress.total = appids.length;
  progress.lastAction = `${inv.items.length} items · ${appids.length} jeux avec cartes`;

  // 2. Pages badges
  const badgesData = {};
  for (let i = 0; i < appids.length; i++) {
    if (!running) break;
    await waitIfPaused();
    const appid = appids[i];
    try {
      const html = await fetchBadgePage(session.steamid, appid, false);
      badgesData[appid] = { normal: parseBadgePage(html), foil: null };
      if (settings.includeFoils && inv.byApp[appid].foilCards.length > 0) {
        await sleep(BADGE_DELAY);
        const foilHtml = await fetchBadgePage(session.steamid, appid, true);
        badgesData[appid].foil = parseBadgePage(foilHtml);
      }
    } catch (_) {
      badgesData[appid] = { normal: null, foil: null };
    }
    progress.done = i + 1;
    progress.lastAction = `Badges ${i + 1}/${appids.length}`;
    await sleep(BADGE_DELAY);
  }

  // 3. Prix (marché complet par jeu, cache 6h)
  progress.lastAction = 'Prix du marché…';
  let priceMap = await getPriceCache();
  const now = Date.now();
  const stale = appids.filter(a => {
    const cards = inv.byApp[a].cards;
    if (!cards.length) return true;
    const p = priceMap[cards[0].mhn];
    return !p || (now - (p.ts || 0) > PRICE_TTL);
  });
  progress.done = 0; progress.total = stale.length;
  for (let i = 0; i < stale.length; i++) {
    if (!running) break;
    await waitIfPaused();
    try {
      const results = await fetchPricesForGame(stale[i], 500);
      priceMap = buildPriceMap(priceMap, results);
    } catch (_) {}
    progress.done = i + 1;
    progress.lastAction = `Prix ${i + 1}/${stale.length}`;
  }
  await setPriceCache(priceMap);

  // 4. Portefeuille réel
  let walletCents = 0;
  try {
    const w = await fetchWallet(session.steamid);
    if (w && w.wallet_balance != null) walletCents = parseInt(w.wallet_balance, 10) || 0;
  } catch (_) {}

  // 5. Plan (algorithme unique max-XP)
  progress.lastAction = 'Calcul du plan…';
  const plan = buildPlan({ badgesData, inv, priceMap, walletCents, settings });
  plan.inv = inv;
  plan.analyzedAt = Date.now();
  await setPlan(plan);

  // Nouvelles files propres
  await setQueue('sell', null);
  await setQueue('buy', null);
  await setQueue('craft', null);

  running = false; currentPhase = null;
  progress.lastAction = 'Analyse terminée';

  return { ok: true, summary: { badges: plan.selected.length, toSellQty: plan.toSell.reduce((s, c) => s + c.qty, 0), toBuyQty: plan.toBuy.reduce((s, c) => s + c.qty, 0), expectedXP: plan.expectedXP } };
}

// ── PHASE 1 : INSTANT SELL (vend au meilleur ordre d'achat réel) ──────────────

const HISTO_MIN_INTERVAL = 3200; // ms — l'histogramme est rate-limité (~20/min)
let lastHistoAt = 0;

async function histoThrottled(nameid) {
  const wait = lastHistoAt + HISTO_MIN_INTERVAL - Date.now();
  if (wait > 0) await sleep(wait);
  lastHistoAt = Date.now();
  return fetchHistogram(nameid, pageGet);
}

async function runPhase1() {
  const session = await resolveSession();
  if (!session.sessionid) throw new Error('Session Steam manquante.');
  const plan = await getPlan();
  if (!plan) throw new Error('Lance d\'abord le scan.');
  const settings = await getSettings();

  let queue = await getQueue('sell');
  if (!queue) {
    queue = expandSellQueue(plan.toSell, plan.inv);
    await setQueue('sell', queue);
  }

  running = true; paused = false; currentPhase = 'phase1';
  progress = { done: 0, total: queue.length, lastAction: 'Préparation des ventes…' };

  const nameids = await getNameIds();
  const bidCache = {}; // mhn → bid réel (résolu une fois par mhn pour ce run)
  let listed = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < queue.length; i++) {
    if (!running) break;
    await waitIfPaused();
    const item = queue[i];
    progress.done = i;
    if (item.done) continue;
    progress.lastAction = `Vente : ${item.name || item.mhn}`;

    try {
      // 1. bid réel (instant sell) — caché par mhn
      if (bidCache[item.mhn] === undefined) {
        if (!nameids[item.mhn]) {
          nameids[item.mhn] = await fetchItemNameId(item.mhn);
          await setNameIds(nameids);
          await sleep(600);
        }
        const h = await histoThrottled(nameids[item.mhn]);
        bidCache[item.mhn] = h.bid;
      }
      const bid = bidCache[item.mhn];
      const priceNet = sellerReceivesForBuyerPays(bid);
      if (!priceNet || priceNet <= 0) {
        item.done = true; item.skipped = true; skipped++;
        progress.lastAction = `Aucun ordre d'achat exploitable : ${item.name || item.mhn}`;
      } else {
        const res = await sellItem({ sessionid: session.sessionid, assetid: item.assetid, priceNet }, pagePost);
        if (res && res.success) {
          item.done = true; listed++;
          progress.lastAction = `Listé à ${(bid / 100).toFixed(2)} € (instant) : ${item.name || item.mhn}`;
        } else {
          item.error = (res && (res.message || JSON.stringify(res))) || 'réponse inconnue';
          errors.push({ mhn: item.mhn, msg: item.error });
          if (/pending|attente/i.test(item.error)) item.done = true;
        }
      }
    } catch (e) {
      item.error = e.message;
      errors.push({ mhn: item.mhn, msg: e.message });
      if (e.status === 429) { progress.lastAction = 'Rate limit — pause 60 s…'; await sleep(60000); }
    }

    queue[i] = item;
    await setQueue('sell', queue);
    await sleep(settings.delayMs || 1000);
  }

  running = false; currentPhase = null;
  const report = { phase: 'Ventes', ok: listed, skipped, fail: errors.length, firstError: errors[0]?.msg || null, ts: Date.now() };
  await setReport(report);
  notify('phase1_done', 'Ventes (instant sell)',
    `${listed} listées au meilleur ordre d'achat — CONFIRME-LES dans l'app Steam Mobile. ${skipped} sans acheteur, ${errors.length} erreurs.`);
  return { ok: true, listed, skipped, errors: errors.length };
}

// ── PHASE 2 : Acheter (instant) + Crafter ─────────────────────────────────────

async function runPhase2() {
  const session = await resolveSession();
  if (!session.sessionid) throw new Error('Session Steam manquante.');
  const plan = await getPlan();
  if (!plan) throw new Error('Lance d\'abord le scan.');
  const settings = await getSettings();

  let buyQueue = await getQueue('buy');
  if (!buyQueue) { buyQueue = expandBuyQueue(plan.toBuy); await setQueue('buy', buyQueue); }
  let craftQueue = await getQueue('craft');
  if (!craftQueue) { craftQueue = expandCraftQueue(plan.selected); await setQueue('craft', craftQueue); }

  // Billing COMPLET exigé uniquement s'il y a des achats à faire
  const needBuy = buyQueue.some(i => !i.done);
  let billing = null;
  if (needBuy) {
    billing = await getBilling();
    if (!isBillingComplete(billing)) {
      await setBilling(null); // purge une capture partielle inutilisable
      throw new Error('Infos de facturation incomplètes. Sur une page du marché Steam, clique « Placer un ordre d\'achat » (sans valider) : l\'adresse pré-remplie sera capturée. Les crafts gratuits, eux, passeront sans.');
    }
  }

  running = true; paused = false; currentPhase = 'phase2';
  progress = { done: 0, total: buyQueue.length + craftQueue.length, lastAction: 'Démarrage…' };

  let bought = 0, crafted = 0;
  const errors = [];

  // Achats : ordre au prix vendeur le plus bas → exécution immédiate
  for (let i = 0; i < buyQueue.length; i++) {
    if (!running) break;
    await waitIfPaused();
    const item = buyQueue[i];
    progress.done = i;
    if (item.done) continue;
    progress.lastAction = `Achat ×${item.qty} : ${item.name || item.mhn}`;

    try {
      const res = await createBuyOrder({
        sessionid: session.sessionid,
        mhn: item.mhn,
        priceTotal: item.askPerCard * item.qty,
        quantity: item.qty,
        billing,
      }, pagePost);
      if (res && res.success === 1) {
        item.done = true; item.orderId = res.buy_orderid; bought += item.qty;
        item.retried = 0;
      } else if (res && res.success === 84) {
        // Rate limit achats ("too many purchases") : on patiente puis on retente cet item
        if ((item.retried || 0) < 2) {
          item.retried = (item.retried || 0) + 1;
          progress.lastAction = 'Limite d\'achats Steam — pause 60 s…';
          await sleep(60000);
          i--; // retente le même item
        } else {
          item.error = 'success=84 — limite d\'achats Steam, réessaie plus tard';
          errors.push({ mhn: item.mhn, msg: item.error });
        }
      } else if (res && res.success === 22) {
        // Billing refusé par Steam : inutile d'insister sur les items suivants
        item.error = 'success=22 — facturation refusée';
        errors.push({ mhn: item.mhn, msg: item.error });
        await setBilling(null); // force une nouvelle capture propre
        progress.lastAction = 'Facturation refusée par Steam — recapture nécessaire, achats interrompus';
        break;
      } else {
        item.error = `success=${res && res.success}${res && res.message ? ' — ' + res.message : ''}`;
        errors.push({ mhn: item.mhn, msg: item.error });
      }
    } catch (e) {
      item.error = e.message;
      errors.push({ mhn: item.mhn, msg: e.message });
      if (e.status === 429) await sleep(30000);
    }

    buyQueue[i] = item;
    await setQueue('buy', buyQueue);
    await sleep(settings.delayMs || 1000);
  }

  // Laisse aux achats le temps d'arriver à l'inventaire avant de crafter
  if (bought > 0 && running) { progress.lastAction = 'Attente livraison des cartes…'; await sleep(6000); }

  // Crafts
  for (let i = 0; i < craftQueue.length; i++) {
    if (!running) break;
    await waitIfPaused();
    const item = craftQueue[i];
    progress.done = buyQueue.length + i;
    if (item.done) continue;
    progress.lastAction = `Craft niv.${item.targetLevel} : ${item.title || item.appid}`;

    try {
      const res = await craftBadge({ sessionid: session.sessionid, steamid: session.steamid, appid: item.appid, foil: item.isFoil }, pagePost);
      if (res && res.success === 1) {
        item.done = true; crafted++;
        progress.lastAction = `Badge crafté (+100 XP) : ${item.title || item.appid}`;
      } else if (res && res.success === 42) {
        item.done = true; item.skipped = true;
        progress.lastAction = `Cartes manquantes, sauté : ${item.title || item.appid}`;
      } else {
        item.error = `success=${res && res.success}`;
        errors.push({ mhn: item.title || item.appid, msg: item.error });
      }
    } catch (e) {
      item.error = e.message;
      errors.push({ mhn: item.title || item.appid, msg: e.message });
    }

    craftQueue[i] = item;
    await setQueue('craft', craftQueue);
    await sleep(settings.delayMs || 1000);
  }

  running = false; currentPhase = null;
  const report = { phase: 'Achat & craft', ok: crafted, bought, fail: errors.length, firstError: errors[0]?.msg || null, ts: Date.now() };
  await setReport(report);
  notify('phase2_done', 'Achat & craft terminés', `${bought} cartes achetées · ${crafted} badges craftés (+${crafted * 100} XP) · ${errors.length} erreurs`);
  return { ok: true, bought, crafted, errors: errors.length };
}

// ── GEMS : broyage intelligent ────────────────────────────────────────────────

async function runGems() {
  const session = await resolveSession();
  if (!session.sessionid) throw new Error('Session Steam manquante.');
  const settings = await getSettings();
  const smart = settings.gemSmart !== false;
  const maxValueCents = settings.gemMaxValueCents || 8;

  running = true; paused = false; currentPhase = 'gems';
  progress = { done: 0, total: 0, lastAction: 'Inventaire…' };

  const rawInv = await fetchInventory(session.steamid);
  const inv = parseInventory(rawInv);
  const grindable = getGrindableItems(inv);

  let priceMap = await getPriceCache();
  const toGrind = [], spared = [];
  for (const item of grindable) {
    if (smart && item.marketable) {
      const p = priceMap[item.mhn];
      const net = p ? (sellerReceivesForBuyerPays(p.instant_buy_cents) || 0) : 0;
      if (net > maxValueCents) { spared.push(item); continue; }
    }
    toGrind.push(item);
  }

  progress.total = toGrind.length;
  progress.lastAction = `${toGrind.length} à broyer · ${spared.length} épargnés`;

  let totalGems = 0;
  const errors = [];
  for (let i = 0; i < toGrind.length; i++) {
    if (!running) break;
    await waitIfPaused();
    const item = toGrind[i];
    progress.done = i;
    progress.lastAction = `Broyage : ${item.name}`;
    try {
      const gooInfo = await getGooValue({ sessionid: session.sessionid, steamid: session.steamid, sourceAppid: item.sourceAppid, assetid: item.assetid }, pageGet);
      if (!gooInfo.goo_value) continue;
      await sleep(300);
      const res = await grindIntoGoo({ sessionid: session.sessionid, steamid: session.steamid, sourceAppid: item.sourceAppid, assetid: item.assetid, gooValueExpected: gooInfo.goo_value }, pagePost);
      if (res.success === 1) totalGems += parseInt(res.goo_value_received || '0', 10);
      else errors.push({ mhn: item.name, msg: `success=${res.success}` });
    } catch (e) { errors.push({ mhn: item.name, msg: e.message }); }
    await sleep(settings.delayMs || 1000);
  }

  running = false; currentPhase = null;
  const report = { phase: 'Gemmes', ok: totalGems, fail: errors.length, firstError: errors[0]?.msg || null, ts: Date.now() };
  await setReport(report);
  notify('gems_done', 'Conversion en gemmes', `${totalGems} gemmes · ${spared.length} objets épargnés · ${errors.length} erreurs`);
  return { ok: true, totalGems, spared: spared.length, errors: errors.length };
}
