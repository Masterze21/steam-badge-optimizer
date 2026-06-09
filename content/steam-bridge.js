// Tourne dans le monde ISOLATED — accès aux APIs chrome (storage, runtime)
// Reçoit les données Steam depuis steam-bridge-main.js via CustomEvent

// Guard contre les injections multiples
if (document.documentElement.getAttribute('data-steam-bridge') === '2') return;
document.documentElement.setAttribute('data-steam-bridge', '2');

(function () {

  function handleSession({ sessionid, steamid, profileURL }) {
    if (!sessionid && !steamid) return;

    const vanity = profileURL
      ? profileURL.replace(/.*\/(id|profiles)\/([^/]+)\/?$/, '$2')
      : null;
    const profileType = profileURL && profileURL.includes('/id/') ? 'id' : 'profiles';

    console.log('[SteamBridge] Session reçue — steamid:', steamid, '| vanity:', vanity);

    if (sessionid) {
      chrome.storage.session.set({ sessionid, steamid, vanity, profileType }, () => {
        if (chrome.runtime.lastError) {
          console.error('[SteamBridge] storage.set error:', chrome.runtime.lastError.message);
        } else {
          console.log('[SteamBridge] Session stockée OK');
        }
      });
      chrome.runtime.sendMessage({ type: 'STEAM_SESSION', sessionid, steamid, vanity, profileType })
        .catch(() => {});
    }
  }

  // Écoute l'événement envoyé par le MAIN world
  document.addEventListener('__sbo_session', e => handleSession(e.detail));

  // Envoie un ping pour déclencher un re-dispatch depuis le MAIN world
  // (cas où l'événement initial a été émis avant que ce listener soit prêt)
  document.dispatchEvent(new CustomEvent('__sbo_ping'));

  // ── Réception billing depuis le MAIN world ───────────────────────────────────
  document.addEventListener('__sbo_billing', e => {
    const billing = e.detail;
    chrome.runtime.sendMessage({ type: 'BILLING_CAPTURED', billing }).catch(() => {});
  });

})();
