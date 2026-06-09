/**
 * optimizer.js — Steam Badge Optimizer v2
 *
 * Améliorations vs v1 :
 *  - 4 stratégies au choix : maxROI, maxXP, maxBadges, maxProfit
 *  - Détection des "crafts gratuits" (toutes cartes possédées)
 *  - Détection des "crafts rentables" (coût net négatif)
 *  - Score ROI = XP gagnée / max(1, coût net en centimes)
 *  - Multi-niveau : si fullSetsInSpare >= 2, on génère autant de candidats
 *  - Seuil de coût max configurable
 *  - Catégorisation : free / profitable / efficient / expensive
 *  - Allocation correcte des doublons entre badges
 */

import { lookupPrice, sellerReceivesForBuyerPays } from './pricing.js';

export const STRATEGIES = {
  maxROI:     'maxROI',     // Maximise XP par centime dépensé
  maxXP:      'maxXP',      // Maximise l'XP absolue obtenue
  maxBadges:  'maxBadges',  // Maximise le nombre de badges (pas cher en premier)
  maxProfit:  'maxProfit',  // Priorise les badges où on récupère de l'argent
};

const XP_PER_LEVEL = { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 };

/**
 * Analyse un badge pour un niveau cible précis.
 * Retourne null si non pertinent (niveau max atteint, jeu exclu, etc.)
 */
export function analyzeBadge(appid, badgeData, isFoil, priceMap, settings, levelOffset = 0) {
  if (!badgeData || !badgeData.cards || !badgeData.cards.length) return null;

  const currentLevel = badgeData.level + levelOffset;
  const targetLevel  = currentLevel + 1;
  const maxLevel     = settings.maxLevel || 5;

  if (currentLevel >= maxLevel) return null;
  if ((settings.excludeAppids || []).includes(String(appid))) return null;
  if (isFoil && !settings.includeFoils) return null;

  const cards = badgeData.cards;
  const cardsOwned   = [];
  const cardsMissing = [];
  let costToComplete = 0;

  for (const c of cards) {
    const name = (c.name || '').trim();
    if (!name || /^\(?\d+\)?$/.test(name)) continue;

    const p = lookupPrice(priceMap, appid, name, isFoil);
    if (!p) continue;

    const instantBuy     = p.instant_buy_cents    || 0;
    const instantSellNet = sellerReceivesForBuyerPays(p.instant_sell_gross || p.instant_buy_cents) || 0;

    // Pour les crafts multi-niveaux : on soustrait levelOffset copies déjà "réservées"
    const availableQty = Math.max(0, (c.owned || 0) - levelOffset);

    if (availableQty > 0) {
      cardsOwned.push({ mhn: p.mhn, name, qty: availableQty, sellNet: instantSellNet, buyCost: instantBuy });
    } else {
      cardsMissing.push({ mhn: p.mhn, name, buyCost: instantBuy, sellNet: instantSellNet });
      costToComplete += instantBuy;
    }
  }

  const sellValueOwned  = cardsOwned.reduce((s, c) => s + c.sellNet, 0);
  const netCostToCraft  = costToComplete + sellValueOwned; // cost opportunité réel

  // Score ROI : XP gagnée par centime investi (∞ pour les crafts gratuits/rentables)
  const xpGained   = XP_PER_LEVEL[Math.min(targetLevel, 5)] || 100;
  const xpPerCent  = netCostToCraft <= 0
    ? Infinity
    : Math.round((xpGained / netCostToCraft) * 1000) / 1000;

  // Catégorie
  let category;
  if (costToComplete === 0 && cardsOwned.length > 0 && cardsMissing.length === 0) {
    category = 'free';      // Toutes les cartes possédées → craft immédiat gratuit
  } else if (netCostToCraft < 0) {
    category = 'profitable'; // Vendre les cartes rapporte plus qu'acheter les manquantes
  } else if (xpPerCent >= 2) {
    category = 'efficient';  // Bon ROI (≥ 2 XP/¢)
  } else {
    category = 'expensive';  // Peu rentable
  }

  // Filtre par coût max
  const maxCostCents = (settings.maxCostPerBadge || 0) * 100;
  if (maxCostCents > 0 && netCostToCraft > maxCostCents) return null;

  return {
    appid:         String(appid),
    isFoil,
    title:         badgeData.badgeTitle,
    currentLevel,
    targetLevel,
    setSize:       badgeData.setSize,
    cardsOwned,
    cardsMissing,
    costToComplete,
    sellValueOwned,
    netCostToCraft,
    xpGained,
    xpPerCent,
    category,
    levelOffset,
  };
}

/**
 * Génère tous les candidats d'un badge, y compris les niveaux supérieurs
 * si l'utilisateur possède déjà plusieurs sets complets (multi-niveau).
 */
export function analyzeBadgeAllLevels(appid, badgeData, isFoil, priceMap, settings) {
  const results = [];
  const maxLevel = settings.maxLevel || 5;

  // Niveaux craftables avec les cartes actuelles (spare sets)
  const spare = badgeData.fullSetsInSpare || 0;

  for (let offset = 0; offset < Math.max(1, spare); offset++) {
    const currentLevel = badgeData.level + offset;
    if (currentLevel >= maxLevel) break;
    const res = analyzeBadge(appid, badgeData, isFoil, priceMap, settings, offset);
    if (res) results.push(res);
    if (offset === 0 && spare === 0) break;
  }
  return results;
}

/**
 * Algorithme d'optimisation principal.
 * Retourne le plan complet (badges sélectionnés, cartes à vendre, à acheter).
 */
export function optimize(candidates, walletCents, strategy = STRATEGIES.maxROI) {
  // ── 1. Classer selon la stratégie ──────────────────────────────────────────
  const sortFn = {
    [STRATEGIES.maxROI]:    (a, b) => {
      // Infini d'abord (free/profitable), puis par xpPerCent décroissant
      if (a.xpPerCent === Infinity && b.xpPerCent !== Infinity) return -1;
      if (b.xpPerCent === Infinity && a.xpPerCent !== Infinity) return  1;
      return b.xpPerCent - a.xpPerCent;
    },
    [STRATEGIES.maxXP]:     (a, b) => {
      // Free/profitable d'abord, puis XP décroissant
      const catA = a.category === 'free' || a.category === 'profitable' ? 0 : 1;
      const catB = b.category === 'free' || b.category === 'profitable' ? 0 : 1;
      if (catA !== catB) return catA - catB;
      return b.xpGained - a.xpGained;
    },
    [STRATEGIES.maxBadges]: (a, b) => a.netCostToCraft - b.netCostToCraft,
    [STRATEGIES.maxProfit]: (a, b) => {
      // Coût net croissant (les plus "rentables" en premier, négatif = gain)
      return a.netCostToCraft - b.netCostToCraft;
    },
  }[strategy] || ((a, b) => a.netCostToCraft - b.netCostToCraft);

  const sorted = [...candidates].sort(sortFn);

  // ── 2. Budget disponible = wallet + revenu si on vend tout ─────────────────
  const totalSellBase = sorted.reduce((s, b) => s + b.sellValueOwned, 0);
  let available = walletCents + totalSellBase;

  // ── 3. Sélection gloutonne ─────────────────────────────────────────────────
  const selected   = [];
  // Tracks how many copies of each mhn are "reserved" for a selected badge
  const reservedQty = {};   // mhn → nb de copies réservées

  for (const b of sorted) {
    // Calcul du coût réel en tenant compte des copies déjà réservées
    const adjustedOwned   = b.cardsOwned.filter(c => {
      const reserved = reservedQty[c.mhn] || 0;
      return c.qty - reserved > 0;
    });
    const adjustedMissing = [
      ...b.cardsMissing,
      ...b.cardsOwned.filter(c => (c.qty - (reservedQty[c.mhn] || 0)) <= 0)
        .map(c => ({ mhn: c.mhn, name: c.name, buyCost: c.buyCost, sellNet: c.sellNet })),
    ];
    const adjustedCostToComplete = adjustedMissing.reduce((s, c) => s + c.buyCost, 0);
    const adjustedSellValue = adjustedOwned.reduce((s, c) => {
      const usable = c.qty - (reservedQty[c.mhn] || 0);
      return s + c.sellNet * Math.min(usable, 1);
    }, 0);
    const adjustedNet = adjustedCostToComplete + adjustedSellValue;

    if (adjustedNet <= available) {
      // Réserver les cartes possédées pour ce badge
      for (const c of b.cardsOwned) {
        const usable = c.qty - (reservedQty[c.mhn] || 0);
        if (usable > 0) reservedQty[c.mhn] = (reservedQty[c.mhn] || 0) + 1;
      }
      available -= adjustedCostToComplete;
      available -= adjustedSellValue;
      selected.push({ ...b, adjustedCardsMissing: adjustedMissing, adjustedCardsOwned: adjustedOwned });
    }
  }

  // ── 4. Cartes à vendre (possédées - réservées) ─────────────────────────────
  const sellMap = {};
  for (const b of candidates) {
    for (const c of b.cardsOwned) {
      const reserved = reservedQty[c.mhn] || 0;
      const qty = c.qty - reserved;
      if (qty <= 0) continue;
      if (!sellMap[c.mhn]) {
        sellMap[c.mhn] = { mhn: c.mhn, name: c.name, appid: b.appid, qty: 0, sellNetPerCard: c.sellNet };
      }
      sellMap[c.mhn].qty += qty;
    }
  }

  // ── 5. Cartes à acheter (manquantes pour les badges sélectionnés) ──────────
  const buyMap = {};
  for (const b of selected) {
    for (const c of (b.adjustedCardsMissing || b.cardsMissing)) {
      if (!buyMap[c.mhn]) {
        buyMap[c.mhn] = { mhn: c.mhn, name: c.name, qty: 0, buyCostPerCard: c.buyCost };
      }
      buyMap[c.mhn].qty += 1;
    }
  }

  const toSell = Object.values(sellMap).filter(s => s.sellNetPerCard > 0);
  const toBuy  = Object.values(buyMap);

  const totalSellRevenue = toSell.reduce((s, c) => s + c.qty * c.sellNetPerCard, 0);
  const totalBuyCost     = toBuy.reduce((s, c) => s + c.qty * c.buyCostPerCard, 0);
  const expectedXP       = selected.reduce((s, b) => s + b.xpGained, 0);

  // ── 6. Stats de catégories ─────────────────────────────────────────────────
  const stats = {
    free:       selected.filter(b => b.category === 'free').length,
    profitable: selected.filter(b => b.category === 'profitable').length,
    efficient:  selected.filter(b => b.category === 'efficient').length,
    expensive:  selected.filter(b => b.category === 'expensive').length,
  };

  return {
    strategy,
    selected,
    toSell,
    toBuy,
    totalSellRevenue,
    totalBuyCost,
    netBalance: totalSellRevenue - totalBuyCost,
    expectedXP,
    stats,
  };
}

// ── Helpers pour les queues d'exécution ───────────────────────────────────────

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
  const queue = [];
  for (const b of toBuy) {
    for (let i = 0; i < b.qty; i++) {
      queue.push({ mhn: b.mhn, name: b.name, buyCost: b.buyCostPerCard });
    }
  }
  return queue;
}

export function expandCraftQueue(selected) {
  return selected.map(b => ({ appid: b.appid, title: b.title, isFoil: b.isFoil, targetLevel: b.targetLevel }));
}
