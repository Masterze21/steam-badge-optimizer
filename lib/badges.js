// Parsing HTML de la page gamecards/{appid}

const LEVEL_RE = /badge_info_description[\s\S]*?Level\s+(\d+)/;
const QTY_RE = /<div class="badge_card_set_text_qty">\(?(\d+)\)?<\/div>/;
const TITLE_RE = /badge_card_set_title ellipsis">([\s\S]*?)<div style="clear:/;
const POSITION_RE = /badge_card_set_text ellipsis">\s*(\d+)\s*of\s*(\d+)(?:,\s*Series\s*(\d+))?/;

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ');
}

export function parseBadgePage(html) {
  const levelM = html.match(LEVEL_RE);
  const level = levelM ? parseInt(levelM[1]) : 0;

  const titleM = html.match(/<div class="badge_title">([\s\S]*?)<\/div>/);
  const badgeTitle = titleM ? stripTags(titleM[1]).trim() : null;

  const cards = [];
  const chunks = html.split(/badge_card_set_card (owned|unowned)">/);

  for (let i = 1; i < chunks.length; i += 2) {
    const state = chunks[i];
    let body = chunks[i + 1] || '';
    const end = body.indexOf('badge_card_set_card ');
    if (end > -1) body = body.slice(0, end);

    const qtyM = QTY_RE.exec(body);
    const qty = state === 'unowned' ? 0 : (qtyM ? parseInt(qtyM[1]) : 0);

    const titleMatchB = TITLE_RE.exec(body);
    let name = null;
    if (titleMatchB) {
      const inner = titleMatchB[1].replace(QTY_RE, '');
      name = stripTags(inner).replace(/\s+/g, ' ').trim();
    }

    const posM = POSITION_RE.exec(body);
    const position = posM ? parseInt(posM[1]) : null;
    const setSize = posM ? parseInt(posM[2]) : null;
    const series = posM ? parseInt(posM[3] || '1') : 1;

    cards.push({ name, position, setSize, series, owned: qty });
  }

  const setSize = (cards[0] && cards[0].setSize) || cards.length;
  const ownedQtys = cards.map(c => c.owned);
  const fullSetsInSpare = ownedQtys.length ? Math.min(...ownedQtys) : 0;

  return { badgeTitle, level, setSize, cards, fullSetsInSpare };
}
