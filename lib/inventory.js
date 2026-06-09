// Parsing de l'inventaire Steam (appid 753, contextid 6)

const ITEM_CLASS_CARD = 'item_class_2';
const ITEM_CLASS_BG   = 'item_class_3';
const ITEM_CLASS_EMOTE = 'item_class_4';
const ITEM_CLASS_BOOSTER = 'item_class_5';
const ITEM_CLASS_GEMS = 'item_class_7';

export function parseInventory(rawData) {
  const { assets = [], descriptions = [] } = rawData;

  // Index descriptions par classid_instanceid
  const descMap = {};
  for (const d of descriptions) {
    descMap[`${d.classid}_${d.instanceid}`] = d;
  }

  const items = [];
  const byApp = {};

  for (const asset of assets) {
    const key = `${asset.classid}_${asset.instanceid}`;
    const desc = descMap[key];
    if (!desc) continue;

    // Extraire les tags utiles
    const tags = desc.tags || [];
    const itemClassTag = tags.find(t => t.category === 'item_class');
    const itemClass = itemClassTag ? itemClassTag.internal_name : null;
    const cardBorderTag = tags.find(t => t.category === 'cardborder');
    const isFoil = cardBorderTag ? cardBorderTag.internal_name === 'cardborder_1' : false;
    const gameTag = tags.find(t => t.category === 'Game');
    const appid = gameTag ? gameTag.internal_name.replace('app_', '') : null;

    if (!itemClass || !appid) continue;

    // Trouver le source_appid pour gems (dans owner_actions)
    let sourceAppid = appid;
    if (desc.owner_actions) {
      for (const a of desc.owner_actions) {
        const m = (a.link || '').match(/GetGooValue\('[^']*','[^']*',(\d+),/);
        if (m) { sourceAppid = m[1]; break; }
      }
    }

    const item = {
      assetid: asset.assetid,
      classid: asset.classid,
      instanceid: asset.instanceid,
      appid,
      sourceAppid,
      mhn: desc.market_hash_name,
      name: desc.name,
      marketable: desc.marketable === 1,
      tradable: desc.tradable === 1,
      itemClass,
      isFoil,
    };

    items.push(item);

    // Grouper par app
    if (!byApp[appid]) byApp[appid] = { cards: [], foilCards: [], backgrounds: [], emoticons: [], boosterPacks: [] };
    if (itemClass === ITEM_CLASS_CARD && !isFoil) byApp[appid].cards.push(item);
    else if (itemClass === ITEM_CLASS_CARD && isFoil) byApp[appid].foilCards.push(item);
    else if (itemClass === ITEM_CLASS_BG) byApp[appid].backgrounds.push(item);
    else if (itemClass === ITEM_CLASS_EMOTE) byApp[appid].emoticons.push(item);
    else if (itemClass === ITEM_CLASS_BOOSTER) byApp[appid].boosterPacks.push(item);
  }

  // Gems globaux
  const gemsItem = items.find(i => i.itemClass === ITEM_CLASS_GEMS);

  return { items, byApp, gemsItem };
}

// Items grindables en gems (backgrounds + emoticons)
export function getGrindableItems(parsedInv) {
  const result = [];
  for (const [appid, group] of Object.entries(parsedInv.byApp)) {
    for (const item of [...group.backgrounds, ...group.emoticons]) {
      result.push(item);
    }
  }
  return result;
}
