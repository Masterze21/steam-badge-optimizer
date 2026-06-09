// Formule des frais Steam + logique de pricing

// Vraie formule Steam : trouve X tel que X + max(1,floor(X*0.05)) + max(1,floor(X*0.10)) == buyerPays
export function sellerReceivesForBuyerPays(buyerPays) {
  if (buyerPays <= 2) return 0;
  for (let x = buyerPays - 1; x >= 1; x--) {
    const steamFee = Math.max(1, Math.floor(x * 0.05));
    const pubFee = Math.max(1, Math.floor(x * 0.10));
    const total = x + steamFee + pubFee;
    if (total === buyerPays) return x;
    if (total < buyerPays) break;
  }
  return null; // pas de match exact — prix impossible
}

// Variantes de market_hash_name (slash ↔ dash, foil suffixes)
export function nameVariants(appid, name, isFoil) {
  const baseNames = [name, name.replace(/\//g, '-'), name.replace(/-/g, '/')];
  const variants = [];
  for (const n of baseNames) {
    if (isFoil) {
      variants.push(`${appid}-${n} (Foil)`);
      variants.push(`${appid}-${n} Foil`);
      variants.push(`${appid}-${n} (Foil Trading Card)`);
    } else {
      variants.push(`${appid}-${n}`);
      variants.push(`${appid}-${n} (Trading Card)`);
    }
  }
  return variants;
}

export function lookupPrice(priceMap, appid, name, isFoil) {
  for (const v of nameVariants(appid, name, isFoil)) {
    if (priceMap[v]) return { mhn: v, ...priceMap[v] };
  }
  // Fallback fuzzy
  const normName = name.toLowerCase().trim();
  const prefix = `${appid}-`;
  for (const [mhn, p] of Object.entries(priceMap)) {
    if (!mhn.startsWith(prefix)) continue;
    const mhnName = mhn.slice(prefix.length).toLowerCase()
      .replace(/\s*\((foil|trading card|foil trading card)\)\s*$/, '').trim();
    if (mhnName === normName) {
      const hasFoil = mhn.toLowerCase().includes('foil');
      if (isFoil === hasFoil) return { mhn, ...p };
    }
  }
  return null;
}

// Construit un map mhn → {instant_buy_cents, instant_sell_net} depuis les résultats fetchPricesForGame
export function buildPriceMap(existingMap, priceResults) {
  const map = { ...existingMap };
  for (const r of priceResults) {
    const sellNet = sellerReceivesForBuyerPays(r.instant_buy_cents) || 0;
    map[r.mhn] = {
      instant_buy_cents: r.instant_buy_cents,
      instant_sell_net: sellNet,
      instant_sell_gross: r.instant_buy_cents,
      ts: Date.now(),
    };
  }
  return map;
}
