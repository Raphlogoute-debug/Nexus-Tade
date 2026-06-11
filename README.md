# Nexus Trade

Jeu de simulation économique et politique spatial, solo, dans le navigateur.
Le joueur (à terme) part d'une concession minière unique et devient une
puissance commerciale qui exploite les guerres entre factions sans jamais
les mener.

**État actuel : Phase 1 terminée** — univers procédural persisté + moteur
économique offre/demande qui tourne en continu, API REST, UI squelette
(carte + inspection de planète). Pas encore de gameplay joueur.

## Lancer

```bash
npm install
npm start          # → http://localhost:3000
```

Au premier lancement, l'univers est généré et persisté dans `nexus-trade.db`
(SQLite). Les lancements suivants reprennent la même partie. Le numéro de
tick s'affiche dans le header et avance toutes les 5 secondes.

```bash
npm run verify     # script de vérification : génère un univers en mémoire,
                   # joue 10 ticks, prouve que les prix suivent l'offre/demande
```

Variables d'environnement : `PORT` (défaut 3000), `TICK_MS` (défaut 5000),
`NEXUS_DB_PATH` (défaut `nexus-trade.db`).

Pour repartir d'un univers neuf sans supprimer le fichier :

```bash
curl -X POST localhost:3000/api/admin/regenerate                  # seed aléatoire
curl -X POST localhost:3000/api/admin/regenerate \
     -H 'Content-Type: application/json' -d '{"seed": 42}'        # seed précise
```

## Ce qui est implémenté (Phase 1)

**Génération procédurale** (`server/universe/`)
- 60 à 100 systèmes positionnés en 2D (distance minimale entre étoiles),
  3 à 6 planètes chacun
- 6 biomes (rocheuse, océanique, gazeuse, désertique, glaciaire, volcanique)
  qui déterminent extraction locale et fourchette de population
- Seed stockée en DB, génération 100 % déterministe (PRNG mulberry32,
  vérifié par `npm run verify`)
- Distances entre toutes les paires de systèmes précalculées en DB
  (futur coût de transport)

**Ressources et chaînes de production** (`data/`)
- 6 ressources brutes, 5 intermédiaires, 3 produits finis
- Recettes en data pur (`data/recipes.js`) : entrées → sortie avec ratios
- Chaque planète reçoit 0 à 3 industries à la génération, biaisées vers les
  recettes dont les entrées sont disponibles localement (les mondes miniers
  ont des aciéries)

**Moteur économique** (`server/economy/`) — module pur, sans Express ni DOM
- Tick serveur toutes les 5 s (configurable), atomique (une transaction SQLite)
- Par planète et par tick : extraction brute → industrie (bornée par les
  stocks d'entrée : une pénurie amont étrangle l'aval) → consommation civile
  (proportionnelle à la population)
- Prix par planète : chaque marché vise un stock « confortable »
  (couverture de N ticks de demande) ; le prix vaut
  `base × (cible/stock)^élasticité`, borné à [0.2×, 5×], puis lissé à 25 %
  par tick. Tous les paramètres dans `server/config.js`.
- Historique de prix conservé (120 ticks) et purgé automatiquement

**API REST** (`server/routes/api.js`)

| Endpoint | Rôle |
|---|---|
| `GET /api/universe` | systèmes, positions, planètes imbriquées |
| `GET /api/planet/:id` | détail planète : population, industries, stocks, prix |
| `GET /api/market/:planetId` | prix courants + historique (60 derniers ticks) |
| `GET /api/state` | tick courant, seed, compteurs, intervalle de tick |
| `POST /api/admin/regenerate` | régénère l'univers (body optionnel `{ "seed": n }`) |

Validation des entrées aux frontières (400/404), erreurs en français.

**UI squelette** (`public/`)
- Deux panneaux : carte canvas à droite (systèmes cliquables, survol avec
  infobulle, halo sur sélection), inspection à gauche
- Sélection système → liste des planètes ; sélection planète → industries,
  stocks, flux net/tick et prix groupés par tier, avec tendance (▲▼) issue
  de l'historique et code couleur achat/vente vs prix de base
- Polling calé sur l'intervalle de tick du serveur ; header avec tick, seed
  et compteurs
- Thème sombre, monospace, zéro asset externe, zéro dépendance front

## Architecture

```
├── server/
│   ├── index.js              # Express + boucle de tick
│   ├── config.js             # tous les réglages (tick, pricing, tailles)
│   ├── db.js                 # init SQLite (better-sqlite3) + schéma
│   ├── universe/
│   │   ├── rng.js            # PRNG déterministe seedé
│   │   └── generator.js      # génération procédurale
│   ├── economy/
│   │   ├── pricing.js        # offre/demande isolée (fonctions pures)
│   │   └── engine.js         # le tick : extraction, industrie, conso, prix
│   └── routes/
│       └── api.js            # endpoints REST
├── data/
│   ├── resources.js          # 14 ressources, 3 tiers, prix de base
│   ├── recipes.js            # chaînes de production
│   └── biomes.js             # profils d'extraction et de population
├── public/                   # UI vanilla (HTML/CSS/JS, modules ES)
└── scripts/
    └── verify.js             # vérification bout en bout sans serveur
```

Le moteur et le générateur reçoivent l'instance DB en paramètre : ils
tournent tels quels sur une base `:memory:` (c'est ce que fait
`scripts/verify.js`).

## Notes de conception

- **Marchés fermés** : en Phase 1, chaque planète est une économie isolée.
  Les déséquilibres (mondes-ruches affamés, géantes gazeuses noyées sous le
  gaz rare invendu) sont voulus : ce sont les opportunités de commerce que
  le joueur exploitera en Phase 2.
- **Tout est data ou config** : ajouter une ressource, une recette ou un
  biome ne touche que `data/` ; rééquilibrer l'économie ne touche que
  `server/config.js`.

## Reste à faire (Phase 2+)

- Le joueur : crédits, concession de départ, achat/vente sur les marchés,
  flotte de transport, temps de trajet et coût en carburant basés sur
  `system_distances`
- Fog of war : l'univers ne se révèle qu'exploré
- Graphes de prix dans l'UI (l'historique est déjà exposé par l'API)
- Factions, politique, guerres, embargos, routes commerciales
- Événements (pénuries, booms miniers) et arbitrage inter-planétaire par
  des PNJ marchands pour que les prix convergent doucement sans le joueur
