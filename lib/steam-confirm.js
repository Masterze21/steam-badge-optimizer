/**
 * steam-confirm.js — Confirmations mobiles Steam Guard (comme SIH).
 *
 * Steam exige une confirmation mobile pour les actions du marché (mises en vente
 * ET ordres d'achat). Avec l'`identity_secret` et le `device_id` de l'authentificateur
 * de l'utilisateur, on signe et on accepte ces confirmations automatiquement —
 * exactement le mécanisme de Steam Inventory Helper.
 *
 * Signature : code = base64( HMAC-SHA1( base64decode(identity_secret), int64BE(time) + tag ) )
 * Endpoints :
 *   GET /mobileconf/getlist?p=<deviceid>&a=<steamid>&k=<code>&t=<time>&m=react&tag=conf
 *   GET /mobileconf/ajaxop?op=allow&p=&a=&k=&t=&m=react&tag=allow&cid=<id>&ck=<nonce>
 * Auth : cookies web de la session (déjà présents). Aucun token mobile requis.
 */

const BASE = 'https://steamcommunity.com';

function base64ToBytes(b64) {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// code = base64(HMAC-SHA1(key=identity_secret, msg=int64BE(time)+tag))
export async function generateConfirmationCode(identitySecretB64, tag, time) {
  const keyBytes = base64ToBytes(identitySecretB64);
  const tagBytes = new TextEncoder().encode(tag || '');
  const data = new Uint8Array(8 + tagBytes.length);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, Math.floor(time / 0x100000000)); // 32 bits de poids fort (≈0)
  dv.setUint32(4, time >>> 0);                      // 32 bits de poids faible
  data.set(tagBytes, 8);

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return bytesToBase64(new Uint8Array(sig));
}

function confQuery({ steamid, deviceId, code, time, tag }) {
  return new URLSearchParams({ p: deviceId, a: String(steamid), k: code, t: String(time), m: 'react', tag });
}

// Heure serveur Steam (pour signer juste) — repli sur l'heure locale.
export async function getSteamTime(getJson) {
  try {
    const d = await getJson('https://api.steampowered.com/ITwoFactorService/QueryTime/v1/', true);
    const st = d && d.response && d.response.server_time;
    if (st) return parseInt(st, 10);
  } catch (_) {}
  return Math.floor(Date.now() / 1000);
}

// Liste les confirmations en attente. `getJson(url)` exécute le GET (dans l'onglet Steam).
export async function fetchConfirmations({ steamid, deviceId, identitySecret, time, getJson }) {
  const code = await generateConfirmationCode(identitySecret, 'conf', time);
  const url = `${BASE}/mobileconf/getlist?${confQuery({ steamid, deviceId, code, time, tag: 'conf' })}`;
  const d = await getJson(url);
  if (!d || d.success === false) {
    throw new Error('Confirmation : ' + ((d && d.message) || 'authentificateur invalide'));
  }
  // Format React : { success:true, conf:[{ id, nonce, creator_id, type, type_name, ... }] }
  return Array.isArray(d.conf) ? d.conf : [];
}

// Accepte (op='allow') ou refuse (op='cancel') une confirmation.
export async function actOnConfirmation({ steamid, deviceId, identitySecret, conf, op, time, getJson }) {
  const code = await generateConfirmationCode(identitySecret, op, time);
  const q = confQuery({ steamid, deviceId, code, time, tag: op });
  q.set('op', op);
  q.set('cid', String(conf.id));
  q.set('ck', String(conf.nonce));
  const d = await getJson(`${BASE}/mobileconf/ajaxop?${q}`);
  return !!(d && d.success);
}
