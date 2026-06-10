/**
 * optimizer.js — Steam Badge Optimizer v4 : UN SEUL algorithme.
 *
 * Objectif : MAXIMISER L'XP. Chaque craft de badge rapporte exactement 100 XP
 * (quel que soit le niveau) → maximiser l'XP = maximiser le NOMBRE de crafts
 * réalisables avec le budget disponible.
 *
 * Budget = portefeuille Steam + valeur instant-sell de toutes les cartes en stock.
 * Coût d'un craft (une étape de niveau d'un badge) :
 *   - cartes manquantes  → achat immédiat au prix vendeur le plus bas (ask)
 *   - cartes possédées consommées → coût d'opportunité (on renonce à les vendre au bid)
 *
 * Sélection : file de priorité sur le coût marginal de chaque étape. Les étapes
 * d'un même badge ont des coûts croissants (les cartes possédées sont consommées
 * d'abord), donc le glouton « moins cher d'abord » est optimal pour le max-count.
 *
 * Ventes : tout ce qui n'est pas consommé par un craft part en INSTANT SELL —
 * vendu au meilleur ordre d'achat (bid). Le bid réel est résolu à l'exécution
 * (itemordershistogram) ; ici on l'estime à ask−1 pour le tri et le bilan.
 *
 * Paramètres (settings) : maxLevel, includeFoils, excludeAppids,
 * maxCostPerBadge (€ par craft, 0 = illimité), multiLevel (false = 1 niveau max/badge).
 */

import { lookupPrice, nameVariants, sellerReceivesForBuyerPays, gameRewardValue } from './pricing.js';

export const XP_PER_CRAFT = 100;

// Estimation prudente du bid quand on ne connaît que l'ask
export function estimateBid(ask) {
  if (!ask || ask < 3) return 0;       // en dessous, le net vendeur est nul
  return ask - 1;                      // spread typique de 1¢ sur les cartes liquides
}

function normName(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Construit le plan complet.
 * @param badgesData  { appid: { normal: {level, cards, setSize, badgeTitle}, foil: {...}|null } }
 * @param inv         sortie de parseInventory (items avec mhn, appid, isFoil, marketable, assetid)
 * @param priceMap    mhn → { instant_buy_cents (ask), kind, ts }
 * @param walletCents solde Steam réel
 * @param settings    paramètres utilisateur
 */
export function buildPlan({ badgesData, inv, priceMap, walletCents = 0, settings = {} }) {
  const maxLevel   = settings.maxLevel || 5;
  const maxCostCts = (settings.maxCostPerBadge || 0) * 100;
  const exclude    = new Set((settings.excludeAppids || []).map(String));
  const multiLevel = settings.multiLevel !== false;

  // ── Inventaire : cartes par jeu (mhn exact + quantités vendables) ────────────
  // invCards: appid → [{ mhn, name, isFoil, totalQty, marketableQty }]
  const invCards = {};
  for (const it of inv.items) {
    if (it.itemClass !== 'item_class_2') continue;
    const key = it.appid;
    if (!invCards[key]) invCards[key] = new Map();
    let e = invCards[key].get(it.mhn);
    if (!e) {
      e = { mhn: it.mhn, name: normName(it.name), isFoil: it.isFoil, totalQty: 0, marketableQty: 0 };
      invCards[key].set(it.mhn, e);
    }
    e.totalQty++;
    if (it.marketable) e.marketableQty++;
  }

  // Associe un nom de carte (page badge) à l'entrée inventaire correspondante
  function findInvCard(appid, slotName, isFoil) {
    const map = invCards[appid];
    if (!map) return null;
    for (const v of nameVariants(appid, slotName, isFoil)) {
      if (map.has(v)) return map.get(v);
    }
    const n = normName(slotName);
    for (const e of map.values()) {
      if (e.isFoil === isFoil && (e.name === n || e.mhn.toLowerCase().includes(n))) return e;
    }
    return null;
  }

  // ── Groupes craftables : économie par slot ───────────────────────────────────
  // group = { key, appid, isFoil, title, L0, slots[], reward }
  const groups = [];
  for (const [appid, v] of Object.entries(badgesData)) {
    if (exclude.has(String(appid))) continue;
    for (const [kind, bd] of [['normal', v.normal], ['foil', v.foil]]) {
      if (!bd || !bd.cards || !bd.cards.length) continue;
      const isFoil = kind === 'foil';
      if (isFoil && !settings.includeFoils) continue;
      const L0 = bd.level || 0;
      if (L0 >= maxLevel) continue;

      const slots = [];
      let parseOk = true;
      for (const c of bd.cards) {
        const name = (c.name || '').trim();
        if (!name || /^\(?\d+\)?$/.test(name)) { parseOk = false; break; }
        const p = lookupPrice(priceMap, appid, name, isFoil);
        const invE = findInvCard(appid, name, isFoil);
        slots.push({
          name,
          owned: c.owned || 0,
          ask: p ? (p.instant_buy_cents || 0) : null,   // null = non coté → achat impossible
          bidNet: sellerReceivesForBuyerPays(estimateBid(p ? p.instant_buy_cents : 0)) || 0,
          buyMhn: p ? p.mhn : null,
          invMhn: invE ? invE.mhn : null,
        });
      }
      if (!parseOk || slots.length < (bd.setSize || slots.length)) continue;

      groups.push({
        key: `${appid}_${isFoil ? 'f' : 'n'}`,
        appid: String(appid), isFoil,
        title: bd.badgeTitle, L0,
        slots,
        reward: gameRewardValue(priceMap, appid),
      });
    }
  }

  // ── Coût marginal de l'étape k (k = 1, 2, …) d'un groupe ────────────────────
  // Étape k : il faut k exemplaires de chaque carte au total.
  function stepCost(g, k) {
    let cash = 0, opp = 0;
    for (const s of g.slots) {
      const usedPrev = Math.min(s.owned, k - 1), buyPrev = (k - 1) - usedPrev;
      const usedNow  = Math.min(s.owned, k),     buyNow  = k - usedNow;
      const dBuy = buyNow - buyPrev, dUse = usedNow - usedPrev;
      if (dBuy > 0) {
        if (s.ask == null || s.ask <= 0) return null; // carte introuvable au marché
        cash += dBuy * s.ask;
      }
      if (dUse > 0) opp += dUse * s.bidNet;
    }
    return { cash, opp, total: cash + opp };
  }

  // ── Budget : wallet + tout ce qu'on PEUT vendre (instant sell estimé) ────────
  let sellableBase = 0;
  for (const map of Object.values(invCards)) {
    for (const e of map.values()) {
      const p = priceMap[e.mhn];
      const net = sellerReceivesForBuyerPays(estimateBid(p ? p.instant_buy_cents : 0)) || 0;
      sellableBase += e.marketableQty * net;
    }
  }
  let budget = walletCents + sellableBase;

  // ── Sélection gloutonne (max nombre de crafts) ───────────────────────────────
  const heap = []; // { g, k, cost }
  for (const g of groups) {
    const c = stepCost(g, 1);
    if (c && (maxCostCts === 0 || c.cash <= maxCostCts)) heap.push({ g, k: 1, cost: c });
  }
  const chosen = new Map(); // key → { g, steps, cash, opp }

  while (heap.length) {
    heap.sort((a, b) => a.cost.total - b.cost.total);
    const u = heap.shift();
    if (u.cost.total > budget) break; // plus rien d'abordable (coûts triés croissants)

    budget -= u.cost.total;
    let e = chosen.get(u.g.key);
    if (!e) { e = { g: u.g, steps: 0, cash: 0, opp: 0 }; chosen.set(u.g.key, e); }
    e.steps++; e.cash += u.cost.cash; e.opp += u.cost.opp;

    const kNext = u.k + 1;
    if (multiLevel && u.g.L0 + kNext <= maxLevel) {
      const c = stepCost(u.g, kNext);
      if (c && (maxCostCts === 0 || c.cash <= maxCostCts)) heap.push({ g: u.g, k: kNext, cost: c });
    }
  }

  // ── Agrégats par badge sélectionné (pour l'UI et la file de craft) ───────────
  const selected = [];
  for (const e of chosen.values()) {
    const { g, steps, cash, opp } = e;
    const net = cash + opp - steps * (g.reward || 0);
    const xp = steps * XP_PER_CRAFT;
    const cat = cash === 0 ? (net < 0 ? 'profitable' : 'free')
              : (net <= 0 ? 'profitable' : (xp / Math.max(1, net) >= 2 ? 'efficient' : 'expensive'));
    const missing = [];
    for (const s of g.slots) {
      const buy = Math.max(0, steps - s.owned);
      if (buy > 0) missing.push({ mhn: s.buyMhn, name: s.name, qty: buy, buyCost: s.ask });
    }
    selected.push({
      groupKey: g.key, appid: g.appid, isFoil: g.isFoil, title: g.title,
      currentLevel: g.L0, targetLevel: g.L0 + steps, sets: steps,
      costToComplete: cash, sellValueOwned: opp, expectedReward: steps * (g.reward || 0),
      netCostToCraft: net, xpGained: xp,
      xpPerCent: net <= 0 ? Infinity : Math.round((xp / net) * 100) / 100,
      category: cat, cardsMissing: missing,
    });
  }

  // ── Ventes : tout l'inventaire cartes NON consommé, en instant sell ──────────
  // consommé(mhn inventaire) = Σ sur groupes choisis des exemplaires possédés utilisés
  const consumed = {};
  for (const e of chosen.values()) {
    for (const s of e.g.slots) {
      const used = Math.min(s.owned, e.steps);
      if (used > 0 && s.invMhn) consumed[s.invMhn] = (consumed[s.invMhn] || 0) + used;
    }
  }
  const toSell = [];
  for (const [appid, map] of Object.entries(invCards)) {
    for (const e of map.values()) {
      const qty = e.marketableQty - (consumed[e.mhn] || 0);
      if (qty <= 0) continue;
      const p = priceMap[e.mhn];
      const estNet = sellerReceivesForBuyerPays(estimateBid(p ? p.instant_buy_cents : 0)) || 0;
      // estNet = 0 → on tente quand même : le bid réel sera résolu à l'exécution
      toSell.push({ mhn: e.mhn, name: e.name, appid, qty, sellNetPerCard: estNet });
    }
  }

  // ── Achats agrégés ────────────────────────────────────────────────────────────
  const buyMap = {};
  for (const b of selected) {
    for (const c of b.cardsMissing) {
      if (!c.mhn) continue;
      if (!buyMap[c.mhn]) buyMap[c.mhn] = { mhn: c.mhn, name: c.name, qty: 0, buyCostPerCard: c.buyCost };
      buyMap[c.mhn].qty += c.qty;
    }
  }
  const toBuy = Object.values(buyMap);

  const totalSellRevenue = toSell.reduce((s, c) => s + c.qty * c.sellNetPerCard, 0);
  const totalBuyCost     = toBuy.reduce((s, c) => s + c.qty * c.buyCostPerCard, 0);

  return {
    algo: 'maxXP-v4',
    walletCents,
    selected: selected.sort((a, b) => b.xpGained - a.xpGained),
    toSell, toBuy,
    totalSellRevenue, totalBuyCost,
    netBalance: totalSellRevenue - totalBuyCost,
    expectedXP: selected.reduce((s, b) => s + b.xpGained, 0),
    expectedReward: selected.reduce((s, b) => s + (b.expectedReward || 0), 0),
    stats: {
      free:       selected.filter(b => b.category === 'free').length,
      profitable: selected.filter(b => b.category === 'profitable').length,
      efficient:  selected.filter(b => b.category === 'efficient').length,
      expensive:  selected.filter(b => b.category === 'expensive').length,
    },
  };
}

// ── Files d'exécution ──────────────────────────────────────────────────────────

export function expandSellQueue(toSell, parsedInv) {
  const queue = [];
  for (const s of toSell) {
    const items = parsedInv.items.filter(i => i.mhn === s.mhn && i.marketable);
    let count = 0;
    for (const item of items) {
      if (count >= s.qty) break;
      queue.push({ assetid: item.assetid, mhn: s.mhn, name: s.name, appid: s.appid, sellNet: s.sellNetPerCard });
      count++;
    }
  }
  return queue;
}

export function expandBuyQueue(toBuy) {
  // Un ordre d'achat par mhn avec quantité agrégée (price_total = ask × qty)
  return toBuy.map(b => ({ mhn: b.mhn, name: b.name, qty: b.qty, askPerCard: b.buyCostPerCard }));
}

export function expandCraftQueue(selected) {
  const queue = [];
  for (const b of selected) {
    for (let i = 0; i < (b.sets || 1); i++) {
      queue.push({ appid: b.appid, title: b.title, isFoil: b.isFoil, targetLevel: b.currentLevel + i + 1 });
    }
  }
  return queue;
}
