// Tourne dans le monde ISOLATED — accès aux APIs chrome (storage, runtime)
// Reçoit les données Steam depuis steam-bridge-main.js via CustomEvent

(function () {
  // Garde anti-injection multiple — à l'intérieur de la fonction (pas de return top-level)
  if (document.documentElement.getAttribute('data-steam-bridge') === '2') return;
  document.documentElement.setAttribute('data-steam-bridge', '2');

  function handleSession({ sessionid, steamid, profileURL }) {
    if (!sessionid && !steamid) return;

    const vanity = profileURL
      ? profileURL.replace(/.*\/(id|profiles)\/([^/]+)\/?$/, '$2')
      : null;
    const profileType = profileURL && profileURL.includes('/id/') ? 'id' : 'profiles';

    if (sessionid) {
      chrome.storage.session.set({ sessionid, steamid, vanity, profileType });
      chrome.runtime.sendMessage({ type: 'STEAM_SESSION', sessionid, steamid, vanity, profileType })
        .catch(() => {});
    }
  }

  // Écoute l'événement envoyé par le MAIN world
  document.addEventListener('__sbo_session', e => handleSession(e.detail));

  // Ping pour déclencher un re-dispatch depuis le MAIN world
  document.dispatchEvent(new CustomEvent('__sbo_ping'));
})();
