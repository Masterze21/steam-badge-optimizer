# Steam Badge Optimizer — Chrome Extension

> Automatise l'optimisation des badges Steam : vente des cartes en double, achat des cartes manquantes et craft des badges, conversion des gemmes.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License MIT](https://img.shields.io/badge/License-MIT-green)

---

## Fonctionnalités

- **Scanner l'inventaire** — analyse ton inventaire Steam, toutes tes pages de badges et les prix du marché en temps réel
- **Vendre les doublons** — met automatiquement en vente les cartes excédentaires au meilleur prix
- **Compléter & Crafter** — place les ordres d'achat pour les cartes manquantes, puis craft les badges
- **Convertir en Gemmes** — broie les fonds d'écran et emoticônes en gemmes

### Algorithme d'optimisation

4 stratégies au choix :

| Stratégie | Description |
|-----------|-------------|
| **Max ROI** | Maximise le ratio XP / centime dépensé |
| **Max XP** | Maximise l'XP total obtenu |
| **Max Badges** | Maximise le nombre de badges craftés |
| **Max Profit** | Priorité aux badges qui rapportent de l'argent net |

Catégories de badges détectées automatiquement :
- 🟢 **Gratuit** — tu possèdes déjà toutes les cartes
- 🟡 **Rentable** — le craft génère un bénéfice net (revente > achat)
- 🔵 **Efficace** — excellent ratio XP/¢ (≥ 2 XP par centime)
- 🔴 **Coûteux** — craft possible mais moins avantageux

---

## Installation

> L'extension n'est pas sur le Chrome Web Store (usage personnel). Installation en mode développeur :

1. **Clone** ce repo ou télécharge le ZIP
2. Ouvre Chrome → `chrome://extensions/`
3. Active le **Mode développeur** (en haut à droite)
4. Clique **Charger l'extension non empaquetée**
5. Sélectionne le dossier `extension/`

---

## Utilisation

1. **Connecte-toi** sur [steamcommunity.com](https://steamcommunity.com) (la session est détectée automatiquement)
2. Pour les **ordres d'achat** : passe une commande sur le marché Steam une fois (l'extension capturera les infos de facturation nécessaires)
3. Ouvre l'extension, configure ta stratégie dans **Réglages**
4. Clique **Scanner l'inventaire**
5. Lance les phases dans l'ordre que tu veux

---

## Confidentialité

- **Aucune donnée n'est envoyée** à un serveur externe
- L'extension communique **uniquement avec steamcommunity.com** (tes appels Steam habituels)
- Aucun mot de passe, aucun identifiant Steam Guard n'est lu ou stocké
- La session Steam (`sessionID`) est lue depuis la page déjà ouverte dans ton navigateur
- Tout est stocké localement via `chrome.storage` (inventaire en cache 6h, réglages)

---

## Structure du projet

```
extension/
├── manifest.json
├── background/
│   └── service-worker.js     # Logique principale, gestion des queues
├── content/
│   └── steam-bridge.js       # Capture sessionID + billing depuis la page Steam
├── lib/
│   ├── steam-api.js          # Appels API Steam (inventaire, marché, craft…)
│   ├── inventory.js          # Parsing de l'inventaire
│   ├── badges.js             # Parsing des pages de badges
│   ├── pricing.js            # Calcul des frais Steam, cache des prix
│   ├── optimizer.js          # Algorithme d'optimisation (4 stratégies)
│   └── storage.js            # Wrappers chrome.storage
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── icons/
```

---

## Avertissement

Cet outil automatise des actions sur le marché Steam. Utilise-le de façon raisonnée :
- Respecte les limites de taux de l'API Steam (délai configurable dans les réglages)
- L'auteur n'est pas responsable d'éventuelles restrictions de compte

---

## Licence

[MIT](LICENSE) — © 2026 Masterze21
