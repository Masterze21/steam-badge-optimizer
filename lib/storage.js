// Wrappers chrome.storage

export async function getSession() {
  return new Promise(resolve => {
    chrome.storage.session.get(['sessionid', 'steamid', 'vanity', 'profileType'], resolve);
  });
}

export async function setSession(data) {
  return new Promise(resolve => chrome.storage.session.set(data, resolve));
}

export async function getBilling() {
  return new Promise(resolve => chrome.storage.local.get('billing', d => resolve(d.billing || null)));
}

export async function setBilling(billing) {
  return new Promise(resolve => chrome.storage.local.set({ billing }, resolve));
}

export async function getState(key) {
  return new Promise(resolve => chrome.storage.local.get(key, d => resolve(d[key] || null)));
}

export async function setState(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
}

export async function getPlan() {
  return getState('plan');
}

export async function setPlan(plan) {
  return setState('plan', plan);
}

export async function getQueue(name) {
  return getState(`queue_${name}`);
}

export async function setQueue(name, queue) {
  return setState(`queue_${name}`, queue);
}

export async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get('settings', d => resolve(d.settings || {
      includeFoils: false,
      maxLevel: 5,
      excludeAppids: [],
      delayMs: 1000,
      gemSmart: true,
      gemMaxValueCents: 8,
    }));
  });
}

export async function setSettings(settings) {
  return new Promise(resolve => chrome.storage.local.set({ settings }, resolve));
}

export async function getPriceCache() {
  return new Promise(resolve => chrome.storage.local.get('priceCache', d => resolve(d.priceCache || {})));
}

export async function setPriceCache(cache) {
  return new Promise(resolve => chrome.storage.local.set({ priceCache: cache }, resolve));
}
