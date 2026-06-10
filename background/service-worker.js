import { getSession, setSession, getBilling, setBilling, getPlan, setPlan, getQueue, setQueue, getSettings, getPriceCache, setPriceCache } from '../lib/storage.js';
import { fetchInventory, fetchBadgePage, fetchPricesForGame, sellItem, createBuyOrder, craftBadge, getGooValue, grindIntoGoo, fetchWallet, sleep } from '../lib/steam-api.js';
import { parseInventory, getGrindableItems } from '../lib/inventory.js';
import { parseBadgePage } from '../lib/badges.js';
import { buildPriceMap, sellerReceivesForBuyerPays } from '../lib/pricing.js';
import { analyzeBadgeAllLevels, optimize, expandSellQueue, expandBuyQueue, expandCraftQueue } from '../lib/optimizer.js';

// ── Message handler unifié ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages depuis le content script
  if (msg.type === 'STEAM_SESSION') {
    setSession({ sessionid: msg.sessionid, steamid: msg.steamid, vanity: msg.vanity, profileType: msg.profileType });
    return false;
  }
  if (msg.type === 'BILLING_CAPTURED') {
    getBilling().then(existing => {
      const incomingComplete = msg.billing && msg.billing.billing_address;
      // On stocke si rien n'existe, ou si l'arrivant est plus complet (a une adresse)
      if (!existing || (incomingComplete && !existing.billing_address)) {
        setBilling(msg.billing);
        if (!existing) {
          chrome.notifications.create('billing_captured', {
            type: 'basic',
            iconUrl: '../icons/icon48.png',
            title: 'Steam Badge Optimizer',
            message: 'Infos de facturation capturées ✓ Tu peux maintenant compléter & crafter.',
          });
        }
      }
    });
    return false;
  }

  // Messages depuis le popup
  switch (msg.type) {
    case 'ANALYZE':
      handleAnalyze().then(sendResponse).catch(e => {
        running = false; currentPhase = null; // évite que l'UI reste bloquée
        sendResponse({ error: e.message });
      });
      return true;
    case 'RUN_PHASE1':
      runPhase1().then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    case 'RUN_PHASE2':
      runPhase2().then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    case 'RUN_GEMS':
      runGems().then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    case 'GET_STATUS':
      getStatus().then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    case 'PAUSE':
      pauseAll();
      sendResponse({ ok: true });
      return false;
    case 'STOP':
      stopAll();
      sendResponse({ ok: true });
      return false;
  }
});

// ── État global d'exécution ────────────────────────────────────────────────────

let running = false;
let paused = false;
let currentPhase = null;
let progress = { done: 0, total: 0, lastAction: '' };
let injectionInProgress = false;   // évite les injections parallèles
let lastInjectionAttempt = 0;      // throttle : 1 tentative / 10s max

function pauseAll() { paused = true; }
function stopAll() { paused = false; running = false; }

async function waitIfPaused() {
  while (paused && running) await sleep(500);
}

async function getStatus() {
  const session = await resolveSession();
  const billing = await getBilling();
  const plan = await getPlan();
  // Si le billing manque, on (ré)injecte le bridge dans les onglets marché ouverts :
  // la capture DOM lira l'adresse pré-remplie sans recharger la page. (fire-and-forget)
  if (!billing) ensureBridgeInSteamTabs();
  return { running, paused, currentPhase, progress, hasSession: !!session.sessionid, hasBilling: !!billing, plan };
}

// Réinjecte les content scripts dans les onglets steamcommunity ouverts (throttlé).
let lastBridgeInject = 0;
async function ensureBridgeInSteamTabs() {
  const now = Date.now();
  if (now - lastBridgeInject < 8000) return; // évite le spam (getStatus est pollé)
  lastBridgeInject = now;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://steamcommunity.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/steam-bridge-main.js'], world: 'MAIN' });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/steam-bridge.js'] });
      } catch (_) { /* onglet inaccessible */ }
    }
  } catch (_) {}
}

// ── Résolution de session (multi-sources, ordre de fiabilité) ──────────────────

// Source #1 (la plus fiable) : lecture directe des cookies Steam.
// chrome.cookies peut lire le sessionid ET le cookie HttpOnly steamLoginSecure
// (qui contient le steamid). Aucune dépendance au content script ni à un onglet ouvert.
async function getSessionFromCookies() {
  try {
    const sc = await chrome.cookies.get({ url: 'https://steamcommunity.com', name: 'sessionid' });
    if (!sc || !sc.value) return null;

    let steamid = '';
    const lc = await chrome.cookies.get({ url: 'https://steamcommunity.com', name: 'steamLoginSecure' });
    if (lc && lc.value) {
      // Format : {steamid64}||{token}  →  steamid = 17 premiers chiffres
      const decoded = decodeURIComponent(lc.value);
      const m = decoded.match(/^(\d{17})/);
      if (m) steamid = m[1];
    }
    return { sessionid: sc.value, steamid };
  } catch (_) {
    return null;
  }
}

async function resolveSession() {
  // 1. Cookies (fiable, immédiat)
  const fromCookies = await getSessionFromCookies();
  if (fromCookies && fromCookies.sessionid && fromCookies.steamid) {
    const stored = await getSession();
    const merged = { ...stored, ...fromCookies }; // conserve vanity/profileType si déjà connus
    await setSession(merged);
    return merged;
  }

  // 2. Session stockée par le content script
  const stored = await getSession();
  if (stored && stored.sessionid && stored.steamid) return stored;

  // 3. Dernier recours : injecter le content script dans un onglet Steam ouvert
  const injected = await tryInjectIntoSteamTabs();
  return injected || stored || {};
}

// Injecte le content script dans les onglets steamcommunity.com déjà ouverts
// pour récupérer la session si elle n'a pas encore été capturée.
async function tryInjectIntoSteamTabs() {
  // Throttle : pas plus d'une tentative toutes les 10 secondes
  const now = Date.now();
  if (injectionInProgress || now - lastInjectionAttempt < 10_000) return null;
  injectionInProgress = true;
  lastInjectionAttempt = now;

  try {
    const tabs = await chrome.tabs.query({ url: 'https://steamcommunity.com/*' });
    for (const tab of tabs) {
      try {
        // 1. MAIN world — lit window.g_sessionID (invisible depuis l'isolated world)
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/steam-bridge-main.js'],
          world: 'MAIN',
        });
        // 2. ISOLATED world — accès chrome.storage, répond au ping du MAIN world
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/steam-bridge.js'],
        });
        // Laisse le temps aux CustomEvents de se propager
        await sleep(400);
        const session = await getSession();
        if (session.sessionid) return session;
      } catch (_) { /* onglet inaccessible (ex: chrome://, about:blank) */ }
    }
  } catch (_) {}

  injectionInProgress = false;
  return null;
}

// ── ANALYSE ───────────────────────────────────────────────────────────────────

async function handleAnalyze() {
  const session = await resolveSession();
  if (!session.steamid) throw new Error('Pas de session Steam détectée. Ouvre steamcommunity.com d\'abord.');

  const settings = await getSettings();
  const PRICE_TTL = 6 * 3600 * 1000; // 6h
  const BADGE_DELAY = 350; // pages badge = GET léger, peu rate-limité

  running = true;
  paused = false;
  currentPhase = 'analyze';
  progress = { done: 0, total: 0, lastAction: 'Récupération de l\'inventaire…' };

  // 1. Inventaire
  const rawInv = await fetchInventory(session.steamid);
  const inv = parseInventory(rawInv);

  // FILTRE : ne scanner que les jeux où on possède des CARTES (item_class_2).
  // Sans ça on scrape une page badge pour chaque jeu ayant emoticône/fond d'écran
  // (~99 jeux) au lieu des ~29 jeux réellement pertinents.
  const exclude = new Set((settings.excludeAppids || []).map(String));
  let appids = Object.keys(inv.byApp).filter(a => {
    if (exclude.has(String(a))) return false;
    const g = inv.byApp[a];
    return g.cards.length > 0 || (settings.includeFoils && g.foilCards.length > 0);
  });

  progress.total = appids.length;
  progress.lastAction = `${inv.items.length} items · ${appids.length} jeux avec cartes`;

  // 2. Badges
  const badgesData = {};
  for (let i = 0; i < appids.length; i++) {
    if (!running) break; // permet l'annulation via STOP
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

  // 3. Prix (avec cache 6h)
  progress.lastAction = 'Récupération des prix du marché…';
  let priceMap = await getPriceCache();
  const now = Date.now();
  const staleAppids = appids.filter(a => {
    // Check si au moins une carte du jeu a un prix récent
    const ownedCards = inv.byApp[a].cards.map(c => c.mhn);
    if (!ownedCards.length) return false;
    const firstMhn = ownedCards[0];
    return !priceMap[firstMhn] || (now - priceMap[firstMhn].ts > PRICE_TTL);
  });

  progress.done = 0;
  progress.total = staleAppids.length;
  for (let i = 0; i < staleAppids.length; i++) {
    if (!running) break; // annulation
    await waitIfPaused();
    const appid = staleAppids[i];
    try {
      const results = await fetchPricesForGame(appid, 500);
      priceMap = buildPriceMap(priceMap, results);
    } catch (_) {}
    progress.done = i + 1;
    progress.lastAction = `Prix ${i + 1}/${staleAppids.length}`;
  }
  await setPriceCache(priceMap);

  // 3b. Solde réel du portefeuille Steam
  let walletCents = 0;
  try {
    const w = await fetchWallet(session.steamid);
    if (w && w.wallet_balance != null) walletCents = parseInt(w.wallet_balance, 10) || 0;
  } catch (_) {}

  // 4. Optimization
  progress.lastAction = 'Calcul du plan…';
  const candidates = [];
  for (const [appid, v] of Object.entries(badgesData)) {
    for (const [kind, bd] of [['normal', v.normal], ['foil', v.foil]]) {
      if (!bd) continue;
      const isFoil = kind === 'foil';
      // analyzeBadgeAllLevels gère multi-niveau + maxLevel en interne
      candidates.push(...analyzeBadgeAllLevels(appid, bd, isFoil, priceMap, settings));
    }
  }

  const plan = optimize(candidates, walletCents, settings.strategy || 'maxROI');
  plan.inv = inv;          // gardé pour les queues d'exécution
  plan.walletCents = walletCents;
  plan.analyzedAt = Date.now();

  await setPlan(plan);

  running = false;
  currentPhase = null;
  progress.lastAction = 'Analyse terminée';

  return {
    ok: true,
    summary: {
      toSell: plan.toSell.length,
      toSellQty: plan.toSell.reduce((s, c) => s + c.qty, 0),
      toBuy: plan.toBuy.length,
      toBuyQty: plan.toBuy.reduce((s, c) => s + c.qty, 0),
      badges: plan.selected.length,
      netBalance: plan.netBalance,
      expectedXP: plan.expectedXP,
    },
  };
}

// ── PHASE 1 : Vendre ──────────────────────────────────────────────────────────

async function runPhase1() {
  const session = await resolveSession();
  if (!session.sessionid) throw new Error('Session Steam manquante.');
  const plan = await getPlan();
  if (!plan) throw new Error('Lance d\'abord l\'analyse.');
  const settings = await getSettings();

  // Reprendre la queue si interrompue
  let queue = await getQueue('sell');
  if (!queue) {
    queue = expandSellQueue(plan.toSell, plan.inv);
    await setQueue('sell', queue);
  }

  running = true;
  paused = false;
  currentPhase = 'phase1';
  progress = { done: 0, total: queue.length, lastAction: 'Démarrage Phase 1...' };

  const errors = [];
  let startIdx = queue.findIndex(i => !i.done);

  for (let i = startIdx; i < queue.length; i++) {
    if (!running) break;
    await waitIfPaused();

    const item = queue[i];
    progress.done = i;
    progress.lastAction = `Vente: ${item.mhn}`;

    try {
      const priceNet = item.sellNet;
      if (!priceNet || priceNet <= 0) {
        item.done = true;
        item.skipped = true;
        continue;
      }
      const res = await sellItem({ sessionid: session.sessionid, steamid: session.steamid, assetid: item.assetid, priceNet });
      if (res.success) {
        item.done = true;
        progress.lastAction = `Listé: ${item.mhn} à ${(priceNet / 100).toFixed(2)}€ — confirmation requise`;
      } else {
        item.error = JSON.stringify(res);
        errors.push(item);
        // "déjà en attente" → skip
        if (res.message && res.message.includes('pending confirmation')) {
          item.done = true;
        }
      }
    } catch (e) {
      item.error = e.message;
      if (e.status === 429) {
        // Rate limit — pause exponentielle
        for (let w = 30; w <= 120; w *= 2) {
          progress.lastAction = `Rate limit, pause ${w}s...`;
          await sleep(w * 1000);
          if (!running) break;
        }
      }
    }

    queue[i] = item;
    await setQueue('sell', queue);
    await sleep(settings.delayMs || 1000);
  }

  running = false;
  currentPhase = null;

  const done = queue.filter(i => i.done && !i.error).length;
  const notification = `${done} cartes listées. Va confirmer sur l'app Steam Mobile → Confirmations.`;
  chrome.notifications.create('phase1_done', {
    type: 'basic', iconUrl: '../icons/icon48.png',
    title: 'Phase 1 terminée', message: notification,
  });

  return { ok: true, done, errors: errors.length };
}

// ── PHASE 2 : Acheter + Crafter ───────────────────────────────────────────────

async function runPhase2() {
  const session = await resolveSession();
  if (!session.sessionid) throw new Error('Session Steam manquante.');
  const billing = await getBilling();
  if (!billing) throw new Error('Infos de facturation manquantes. Fais un achat manuel sur le marché Steam d\'abord.');
  const plan = await getPlan();
  if (!plan) throw new Error('Lance d\'abord l\'analyse.');
  const settings = await getSettings();

  // Queue achats
  let buyQueue = await getQueue('buy');
  if (!buyQueue) {
    buyQueue = expandBuyQueue(plan.toBuy);
    await setQueue('buy', buyQueue);
  }

  // Queue crafts
  let craftQueue = await getQueue('craft');
  if (!craftQueue) {
    craftQueue = expandCraftQueue(plan.selected);
    await setQueue('craft', craftQueue);
  }

  running = true;
  paused = false;
  currentPhase = 'phase2';
  progress = { done: 0, total: buyQueue.length + craftQueue.length, lastAction: 'Démarrage Phase 2...' };

  // Achats
  for (let i = 0; i < buyQueue.length; i++) {
    if (!running) break;
    await waitIfPaused();

    const item = buyQueue[i];
    if (item.done) { progress.done++; continue; }
    progress.lastAction = `Achat: ${item.mhn}`;

    try {
      const res = await createBuyOrder({
        sessionid: session.sessionid,
        mhn: item.mhn,
        priceTotal: item.buyCost,
        billing,
      });
      if (res.success === 1) {
        item.done = true;
        item.orderId = res.buy_orderid;
        progress.lastAction = `Acheté: ${item.mhn}`;
      } else {
        item.error = `success=${res.success}`;
        // success:22 = billing manquant (ne devrait pas arriver ici)
      }
    } catch (e) {
      item.error = e.message;
      if (e.status === 429) await sleep(30000);
    }

    buyQueue[i] = item;
    progress.done = i + 1;
    await setQueue('buy', buyQueue);
    await sleep(settings.delayMs || 1000);
  }

  // Crafts
  for (let i = 0; i < craftQueue.length; i++) {
    if (!running) break;
    await waitIfPaused();

    const item = craftQueue[i];
    if (item.done) { progress.done++; continue; }
    progress.lastAction = `Craft: ${item.title || item.appid}`;

    try {
      const res = await craftBadge({ sessionid: session.sessionid, steamid: session.steamid, appid: item.appid, foil: item.isFoil });
      if (res.success === 1) {
        item.done = true;
        item.badge = res.Badge;
        item.drops = res.rgDroppedItems || [];
        progress.lastAction = `Badge crafté: ${item.badge?.game || item.appid}`;
      } else if (res.success === 42) {
        item.done = true;
        item.skipped = true;
        progress.lastAction = `Skipped (cartes manquantes): ${item.appid}`;
      } else {
        item.error = `success=${res.success}`;
      }
    } catch (e) {
      item.error = e.message;
    }

    craftQueue[i] = item;
    progress.done = buyQueue.length + i + 1;
    await setQueue('craft', craftQueue);
    await sleep(settings.delayMs || 1000);
  }

  running = false;
  currentPhase = null;

  const craftedCount = craftQueue.filter(i => i.done && !i.skipped).length;
  const boughtCount = buyQueue.filter(i => i.done).length;
  const totalXP = craftedCount * 100;

  chrome.notifications.create('phase2_done', {
    type: 'basic', iconUrl: '../icons/icon48.png',
    title: 'Phase 2 terminée',
    message: `${boughtCount} cartes achetées. ${craftedCount} badges craftés ! +${totalXP} XP`,
  });

  return { ok: true, bought: boughtCount, crafted: craftedCount };
}

// ── GEMS : Grinder les récompenses ────────────────────────────────────────────

async function runGems() {
  const session = await resolveSession();
  if (!session.sessionid) throw new Error('Session Steam manquante.');
  const settings = await getSettings();

  const smart        = settings.gemSmart !== false;       // grind intelligent (défaut ON)
  const maxValueCents = settings.gemMaxValueCents || 8;    // au-dessus → mieux vaut revendre

  running = true;
  paused = false;
  currentPhase = 'gems';
  progress = { done: 0, total: 0, lastAction: 'Récupération de l\'inventaire…' };

  const rawInv = await fetchInventory(session.steamid);
  const inv = parseInventory(rawInv);
  const grindable = getGrindableItems(inv);

  // ── Grind intelligent : on charge les prix des jeux concernés (cache 6h) ─────
  let priceMap = await getPriceCache();
  if (smart) {
    const PRICE_TTL = 6 * 3600 * 1000;
    const now = Date.now();
    const appids = [...new Set(grindable.map(g => g.appid))];
    const stale = appids.filter(a => {
      const sample = grindable.find(g => g.appid === a);
      return !sample || !priceMap[sample.mhn] || (now - (priceMap[sample.mhn].ts || 0) > PRICE_TTL);
    });
    progress.total = stale.length;
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
  }

  // ── Décision : broyer ou épargner ────────────────────────────────────────────
  const toGrind = [];
  const spared = [];
  for (const item of grindable) {
    if (smart && item.marketable) {
      const p = priceMap[item.mhn];
      const sellNet = p ? (p.instant_sell_net || 0) : 0;
      if (sellNet > maxValueCents) { spared.push({ ...item, sellNet }); continue; }
    }
    toGrind.push(item);
  }

  progress.done = 0;
  progress.total = toGrind.length;
  progress.lastAction = `${toGrind.length} à broyer · ${spared.length} épargnés (revente plus rentable)`;

  let totalGems = 0;
  for (let i = 0; i < toGrind.length; i++) {
    if (!running) break;
    await waitIfPaused();

    const item = toGrind[i];
    progress.done = i;
    progress.lastAction = `Broyage : ${item.name}`;

    try {
      const gooInfo = await getGooValue({ sessionid: session.sessionid, steamid: session.steamid, sourceAppid: item.sourceAppid, assetid: item.assetid });
      if (!gooInfo.goo_value) continue;
      await sleep(300);
      const res = await grindIntoGoo({ sessionid: session.sessionid, steamid: session.steamid, sourceAppid: item.sourceAppid, assetid: item.assetid, gooValueExpected: gooInfo.goo_value });
      if (res.success === 1) {
        totalGems += parseInt(res.goo_value_received || '0');
        progress.lastAction = `Broyé : ${item.name} → ${res.goo_value_received} gemmes`;
      }
    } catch (e) {
      progress.lastAction = `Erreur : ${item.name} — ${e.message}`;
    }

    await sleep(settings.delayMs || 1000);
  }

  running = false;
  currentPhase = null;

  const sparedMsg = spared.length ? ` ${spared.length} objets épargnés (à revendre).` : '';
  chrome.notifications.create('gems_done', {
    type: 'basic', iconUrl: '../icons/icon48.png',
    title: 'Conversion en gemmes terminée',
    message: `${totalGems} gemmes obtenues depuis ${toGrind.length} objets.${sparedMsg}`,
  });

  return { ok: true, totalGems, count: toGrind.length, spared: spared.length };
}
