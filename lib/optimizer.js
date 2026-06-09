/**
 * optimizer.js — Steam Badge Optimizer v3
 *
 * Modèle économique correct :
 *   Pour crafter un badge il faut 1 exemplaire de chaque carte du set.
 *   - cartes manquantes → ACHAT (coût cash = costToComplete)
 *   - cartes possédées utilisées → COÛT D'OPPORTUNITÉ (on renonce à les revendre)
 *   - chaque craft octroie 1 récompense aléatoire (fond/emoticône) → VALEUR espérée
 *
 *   coût réel (trueCost) = cash d'achat + coût d'opportunité − récompense espérée
 *   ROI = XP gagnée / max(1, trueCost)
 *
 * Multi-niveau CUMULATIF : pour un badge niveau L0, on génère un candidat par
 *   niveau-cible T (L0+1 … maxLevel). Chaque candidat est cumulatif (sets = T−L0
 *   crafts, XP cumulée, cartes nécessaires = sets exemplaires de chaque carte).
 *   L'optimiseur sélectionne AU PLUS UN candidat par badge (le meilleur niveau-cible).
 *
 * Catégories (toutes atteignables) :
 *   free       — aucune carte à acheter (costToComplete = 0)
 *   profitable — trueCost < 0 (la récompense dépasse le coût total)
 *   efficient  — bon ROI (≥ 2 XP/¢)
 *   expensive  — ROI faible
 */

import { lookupPrice, sellerReceivesForBuyerPays, gameRewardValue } from './pricing.js';

export const STRATEGIES = {
  maxROI:     'maxROI',     // Maximise XP par centime de coût réel
  maxXP:      'maxXP',      // Maximise l'XP absolue obtenue
  maxBadges:  'maxBadges',  // Maximise le nombre de niveaux gagnés (pas cher d'abord)
  maxProfit:  'maxProfit',  // Priorise les crafts au coût réel le plus bas (gains d'abord)
};

const XP_PER_LEVEL = { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 };

// XP cumulée pour passer du niveau L0 (exclus) au niveau T (inclus)
function xpForLevels(L0, T) {
  let xp = 0;
  for (let l = L0 + 1; l <= T; l++) xp += XP_PER_LEVEL[Math.min(l, 5)] || 100;
  return xp;
}

// Économie de chaque carte du set (prix d'achat + net de revente), une seule fois
function cardEconomics(appid, badgeData, isFoil, priceMap) {
  const out = [];
  for (const c of badgeData.cards) {
    const name = (c.name || '').trim();
    if (!name || /^\(?\d+\)?$/.test(name)) continue; // ignore les libellés numériques parasites
    const p = lookupPrice(priceMap, appid, name, isFoil);
    out.push({
      mhn:     p ? p.mhn : `${appid}-${name}`,
      name,
      owned:   c.owned || 0,
      buyCost: p ? (p.instant_buy_cents || 0) : null,            // null = non coté
      sellNet: p ? (p.instant_sell_net || 0) : 0,
      priced:  !!p,
    });
  }
  return out;
}

/**
 * Génère tous les candidats (un par niveau-cible) d'un badge.
 * Chaque candidat est cumulatif et autonome.
 */
export function analyzeBadgeAllLevels(appid, badgeData, isFoil, priceMap, settings) {
  if (!badgeData || !badgeData.cards || !badgeData.cards.length) return [];
  if ((settings.excludeAppids || []).includes(String(appid))) return [];
  if (isFoil && !settings.includeFoils) return [];

  const maxLevel = settings.maxLevel || 5;
  const L0 = badgeData.level || 0;
  if (L0 >= maxLevel) return [];

  const cards = cardEconomics(appid, badgeData, isFoil, priceMap);
  if (!cards.length) return [];

  // Set incomplet au parsing → on s'abstient pour éviter un craft voué à l'échec
  const setSize = badgeData.setSize || cards.length;
  if (cards.length < setSize) return [];

  const reward      = gameRewardValue(priceMap, appid); // net espéré d'1 récompense
  const groupKey    = `${appid}_${isFoil ? 'f' : 'n'}`;
  const multiLevel  = settings.multiLevel !== false;
  const maxTarget   = multiLevel ? maxLevel : L0 + 1;
  const maxCostCents = (settings.maxCostPerBadge || 0) * 100;

  // Valeur totale des cartes possédées (pour le calcul du budget, identique à tous les niveaux)
  const ownedTotalValue = cards.reduce((s, c) => s + c.owned * c.sellNet, 0);
  const allOwnedCards = cards
    .filter(c => c.owned > 0)
    .map(c => ({ mhn: c.mhn, name: c.name, owned: c.owned, sellNet: c.sellNet }));

  const out = [];
  for (let T = L0 + 1; T <= maxTarget; T++) {
    const sets = T - L0; // nombre de crafts nécessaires

    let cashCost = 0, oppCost = 0, unpriceableMissing = false;
    const missing = [], ownedUse = [];

    for (const c of cards) {
      const buy     = Math.max(0, sets - c.owned);     // exemplaires à acheter
      const useOwn  = Math.min(c.owned, sets);          // exemplaires possédés consommés
      if (buy > 0) {
        if (c.buyCost == null) { unpriceableMissing = true; break; } // achat impossible à chiffrer
        cashCost += buy * c.buyCost;
        missing.push({ mhn: c.mhn, name: c.name, qty: buy, buyCost: c.buyCost });
      }
      if (useOwn > 0) {
        oppCost += useOwn * c.sellNet;
        ownedUse.push({ mhn: c.mhn, name: c.name, qty: useOwn, sellNet: c.sellNet });
      }
    }

    if (unpriceableMissing) break;                 // inutile d'escalader les niveaux suivants
    if (maxCostCents > 0 && cashCost > maxCostCents) break; // au-delà du budget/badge

    const rewardTotal = sets * reward;
    const xpGained    = xpForLevels(L0, T);
    const trueCost    = cashCost + oppCost - rewardTotal;
    const cashNet     = cashCost - rewardTotal;
    const xpPerCent   = trueCost <= 0 ? Infinity : Math.round((xpGained / trueCost) * 1000) / 1000;

    // Ordre de priorité : un craft gratuit ET rentable mérite le label "rentable"
    let category;
    if (trueCost < 0)                            category = 'profitable'; // on NET de la valeur
    else if (cashCost === 0 && missing.length === 0) category = 'free';   // 0 cash requis
    else if (xpPerCent >= 2)                     category = 'efficient';  // bon ROI
    else                                         category = 'expensive';  // ROI faible

    out.push({
      groupKey, appid: String(appid), isFoil,
      title: badgeData.badgeTitle,
      currentLevel: L0, targetLevel: T, sets, setSize,
      cardsMissing: missing, cardsOwned: ownedUse,
      allOwnedCards, ownedTotalValue,
      costToComplete: cashCost,
      sellValueOwned: oppCost,
      expectedReward: rewardTotal,
      netCostToCraft: trueCost,
      cashNet, xpGained, xpPerCent, category,
    });
  }
  return out;
}

/** Compat : analyse un seul niveau (offset 0). */
export function analyzeBadge(appid, badgeData, isFoil, priceMap, settings) {
  const all = analyzeBadgeAllLevels(appid, badgeData, isFoil, priceMap, { ...settings, multiLevel: false });
  return all[0] || null;
}

/**
 * Optimisation principale.
 * Sélectionne au plus un candidat par badge, sous contrainte de budget.
 */
export function optimize(candidates, walletCents = 0, strategy = STRATEGIES.maxROI) {
  // ── 1. Tri selon la stratégie ──────────────────────────────────────────────
  const sortFn = {
    [STRATEGIES.maxROI]: (a, b) => {
      if (a.xpPerCent === Infinity && b.xpPerCent === Infinity) return a.netCostToCraft - b.netCostToCraft;
      if (a.xpPerCent === Infinity) return -1;
      if (b.xpPerCent === Infinity) return  1;
      return b.xpPerCent - a.xpPerCent;
    },
    [STRATEGIES.maxXP]: (a, b) => {
      const rank = c => (c === 'free' || c === 'profitable') ? 0 : 1;
      const ra = rank(a.category), rb = rank(b.category);
      if (ra !== rb) return ra - rb;
      return b.xpGained - a.xpGained;
    },
    [STRATEGIES.maxBadges]: (a, b) => {
      // Le plus de niveaux pour le moins cher : coût réel croissant, puis +de sets
      if (a.netCostToCraft !== b.netCostToCraft) return a.netCostToCraft - b.netCostToCraft;
      return b.sets - a.sets;
    },
    [STRATEGIES.maxProfit]: (a, b) => a.netCostToCraft - b.netCostToCraft,
  }[strategy] || ((a, b) => a.netCostToCraft - b.netCostToCraft);

  const sorted = [...candidates].sort(sortFn);

  // ── 2. Budget = wallet + valeur de revente de TOUTES les cartes possédées ────
  // (dédupliqué par badge : on ne compte chaque jeu qu'une fois via groupKey)
  const groupOwnedValue = {};
  for (const c of candidates) {
    if (!(c.groupKey in groupOwnedValue)) groupOwnedValue[c.groupKey] = c.ownedTotalValue || 0;
  }
  const sellableBase = Object.values(groupOwnedValue).reduce((s, v) => s + v, 0);
  let available = walletCents + sellableBase;

  // ── 3. Sélection gloutonne : au plus un candidat par badge ───────────────────
  const decided  = {};   // groupKey → candidat sélectionné
  const selected = [];

  // Les candidats sont triés best-first. Pour chaque badge on retient le PREMIER
  // candidat abordable rencontré : si son meilleur niveau-cible est trop cher, un
  // niveau-cible moins coûteux du même badge apparaît plus loin et sera rattrapé ici.
  for (const cand of sorted) {
    if (decided[cand.groupKey]) continue; // badge déjà décidé

    // Ponction sur le budget : cash d'achat + valeur des cartes possédées consommées
    // (ces cartes ne seront plus vendues). La récompense n'est PAS du cash (objet reçu).
    const drain = cand.costToComplete + cand.sellValueOwned;
    if (drain <= available) {
      available -= drain;
      decided[cand.groupKey] = cand;
      selected.push(cand);
    }
  }

  // ── 4. Cartes à vendre : tout le possédé NON consommé par un craft ───────────
  const sellMap = {};
  function addSell(mhn, name, appid, qty, sellNet) {
    if (qty <= 0 || sellNet <= 0) return;
    if (!sellMap[mhn]) sellMap[mhn] = { mhn, name, appid, qty: 0, sellNetPerCard: sellNet };
    sellMap[mhn].qty += qty;
  }

  // Map des cartes consommées par badge sélectionné (mhn → qty)
  for (const groupKey in groupOwnedValue) {
    const sel = decided[groupKey];
    // Cartes possédées du groupe (depuis n'importe quel candidat du groupe)
    const anyCand = candidates.find(c => c.groupKey === groupKey);
    if (!anyCand) continue;
    const consumed = {};
    if (sel) for (const u of sel.cardsOwned) consumed[u.mhn] = (consumed[u.mhn] || 0) + u.qty;
    for (const oc of (anyCand.allOwnedCards || [])) {
      const leftover = oc.owned - (consumed[oc.mhn] || 0);
      addSell(oc.mhn, oc.name, anyCand.appid, leftover, oc.sellNet);
    }
  }

  // ── 5. Cartes à acheter (pour les badges sélectionnés) ───────────────────────
  const buyMap = {};
  for (const b of selected) {
    for (const c of b.cardsMissing) {
      if (!buyMap[c.mhn]) buyMap[c.mhn] = { mhn: c.mhn, name: c.name, qty: 0, buyCostPerCard: c.buyCost };
      buyMap[c.mhn].qty += c.qty;
    }
  }

  const toSell = Object.values(sellMap);
  const toBuy  = Object.values(buyMap);

  const totalSellRevenue = toSell.reduce((s, c) => s + c.qty * c.sellNetPerCard, 0);
  const totalBuyCost     = toBuy.reduce((s, c) => s + c.qty * c.buyCostPerCard, 0);
  const expectedXP       = selected.reduce((s, b) => s + b.xpGained, 0);
  const expectedReward   = selected.reduce((s, b) => s + (b.expectedReward || 0), 0);

  const stats = {
    free:       selected.filter(b => b.category === 'free').length,
    profitable: selected.filter(b => b.category === 'profitable').length,
    efficient:  selected.filter(b => b.category === 'efficient').length,
    expensive:  selected.filter(b => b.category === 'expensive').length,
  };

  return {
    strategy,
    walletCents,
    selected,
    toSell,
    toBuy,
    totalSellRevenue,
    totalBuyCost,
    netBalance: totalSellRevenue - totalBuyCost,
    expectedXP,
    expectedReward,
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
  // Un badge niveau L0 → cible T nécessite (T − L0) crafts successifs
  const queue = [];
  for (const b of selected) {
    const sets = b.sets || (b.targetLevel - b.currentLevel) || 1;
    for (let i = 0; i < sets; i++) {
      queue.push({
        appid: b.appid, title: b.title, isFoil: b.isFoil,
        targetLevel: b.currentLevel + i + 1,
      });
    }
  }
  return queue;
}
