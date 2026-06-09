import { getSession, setSession, getBilling, setBilling, getPlan, setPlan, getQueue, setQueue, getSettings, getPriceCache, setPriceCache } from '../lib/storage.js';
import { fetchInventory, fetchBadgePage, fetchPricesForGame, sellItem, createBuyOrder, craftBadge, getGooValue, grindIntoGoo, sleep } from '../lib/steam-api.js';
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
      if (!existing) {
        setBilling(msg.billing);
        chrome.notifications.create('billing_captured', {
          type: 'basic',
          iconUrl: '../icons/icon48.png',
          title: 'Steam Badge Optimizer',
          message: 'Infos de facturation capturées ! Tu peux maintenant utiliser la Phase 2.',
        });
      }
    });
    return false;
  }

  // Messages depuis le popup
  switch (msg.type) {
    case 'ANALYZE':
      handleAnalyze().then(sendResponse).catch(e => sendResponse({ error: e.message }));
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

function pauseAll() { paused = true; }
function stopAll() { paused = false; running = false; }

async function waitIfPaused() {
  while (paused && running) await sleep(500);
}

async function getStatus() {
  const session = await getSession();
  const billing = await getBilling();
  const plan = await getPlan();
  return { running, paused, currentPhase, progress, hasSession: !!session.sessionid, hasBilling: !!billing, plan };
}

// ── ANALYSE ───────────────────────────────────────────────────────────────────

async function handleAnalyze() {
  const session = await getSession();
  if (!session.steamid) throw new Error('Pas de session Steam détectée. Ouvre steamcommunity.com d\'abord.');

  const settings = await getSettings();
  const PRICE_TTL = 6 * 3600 * 1000; // 6h

  progress = { done: 0, total: 0, lastAction: 'Récupération inventaire...' };

  // 1. Inventaire
  const rawInv = await fetchInventory(session.steamid);
  const inv = parseInventory(rawInv);
  const appids = Object.keys(inv.byApp);
  progress.total = appids.length;
  progress.lastAction = `Inventaire: ${inv.items.length} items, ${appids.length} jeux`;

  // 2. Badges
  progress.lastAction = 'Scraping badges...';
  const badgesData = {};
  for (let i = 0; i < appids.length; i++) {
    const appid = appids[i];
    try {
      const html = await fetchBadgePage(session.steamid, appid, false);
      badgesData[appid] = { normal: parseBadgePage(html), foil: null };
      if (settings.includeFoils && inv.byApp[appid].foilCards.length > 0) {
        const foilHtml = await fetchBadgePage(session.steamid, appid, true);
        badgesData[appid].foil = parseBadgePage(foilHtml);
      }
    } catch (_) {
      badgesData[appid] = { normal: null, foil: null };
    }
    progress.done = i + 1;
    progress.lastAction = `Badges ${i + 1}/${appids.length}`;
    await sleep(settings.delayMs || 1000);
  }

  // 3. Prix (avec cache 6h)
  progress.lastAction = 'Récupération des prix...';
  let priceMap = await getPriceCache();
  const now = Date.now();
  const staleAppids = appids.filter(a => {
    // Check si au moins une carte du jeu a un prix récent
    const ownedCards = inv.byApp[a].cards.map(c => c.mhn);
    if (!ownedCards.length) return false;
    const firstMhn = ownedCards[0];
    return !priceMap[firstMhn] || (now - priceMap[firstMhn].ts > PRICE_TTL);
  });

  for (let i = 0; i < staleAppids.length; i++) {
    const appid = staleAppids[i];
    try {
      const results = await fetchPricesForGame(appid, settings.delayMs || 1000);
      priceMap = buildPriceMap(priceMap, results);
    } catch (_) {}
    progress.lastAction = `Prix ${i + 1}/${staleAppids.length}`;
  }
  await setPriceCache(priceMap);

  // 4. Optimization
  progress.lastAction = 'Calcul du plan...';
  const candidates = [];
  for (const [appid, v] of Object.entries(badgesData)) {
    for (const [kind, bd] of [['normal', v.normal], ['foil', v.foil]]) {
      if (!bd) continue;
      const isFoil = kind === 'foil';
      // Multi-niveau : génère un candidat par niveau craftable
      const multiLevel = settings.multiLevel !== false;
      if (multiLevel) {
        const levels = analyzeBadgeAllLevels(appid, bd, isFoil, priceMap, settings);
        candidates.push(...levels);
      } else {
        // Import statique utilisé via analyzeBadgeAllLevels en mode offset=0 seulement
        const res = analyzeBadgeAllLevels(appid, bd, isFoil, priceMap, { ...settings, maxLevel: (badgesData[appid]?.level || 0) + 1 });
        candidates.push(...res);
      }
    }
  }

  const walletCents = 0; // TODO: parse wallet depuis la page marché
  const plan = optimize(candidates, walletCents, settings.strategy || 'maxROI');
  plan.inv = inv; // Garder pour expand queues
  plan.analyzedAt = Date.now();

  await setPlan(plan);

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
  const session = await getSession();
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

  const username = session.vanity || session.steamid;
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
      const res = await sellItem({ sessionid: session.sessionid, assetid: item.assetid, priceNet, username });
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
  const session = await getSession();
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
  const session = await getSession();
  if (!session.sessionid) throw new Error('Session Steam manquante.');
  const settings = await getSettings();

  running = true;
  paused = false;
  currentPhase = 'gems';
  progress = { done: 0, total: 0, lastAction: 'Récupération inventaire pour gems...' };

  // Récupérer inventaire frais
  const rawInv = await fetchInventory(session.steamid);
  const inv = parseInventory(rawInv);
  const grindable = getGrindableItems(inv);

  progress.total = grindable.length;
  progress.lastAction = `${grindable.length} items grindables trouvés`;

  const username = session.vanity || session.steamid;
  let totalGems = 0;

  for (let i = 0; i < grindable.length; i++) {
    if (!running) break;
    await waitIfPaused();

    const item = grindable[i];
    progress.done = i;
    progress.lastAction = `Grind: ${item.name}`;

    try {
      // 1. Obtenir la valeur
      const gooInfo = await getGooValue({ sessionid: session.sessionid, username, sourceAppid: item.sourceAppid, assetid: item.assetid });
      if (!gooInfo.goo_value) continue;

      await sleep(300);

      // 2. Grinder
      const res = await grindIntoGoo({ sessionid: session.sessionid, username, sourceAppid: item.sourceAppid, assetid: item.assetid, gooValueExpected: gooInfo.goo_value });
      if (res.success === 1) {
        totalGems += parseInt(res.goo_value_received || '0');
        progress.lastAction = `Grindé: ${item.name} → ${res.goo_value_received} gems`;
      }
    } catch (e) {
      progress.lastAction = `Erreur: ${item.name} — ${e.message}`;
    }

    await sleep(settings.delayMs || 1000);
  }

  running = false;
  currentPhase = null;

  chrome.notifications.create('gems_done', {
    type: 'basic', iconUrl: '../icons/icon48.png',
    title: 'Gems terminé',
    message: `${totalGems} gems obtenus depuis ${grindable.length} items.`,
  });

  return { ok: true, totalGems, count: grindable.length };
}
