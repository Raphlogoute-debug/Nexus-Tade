# Nexus Trade

Jeu de simulation économique et politique spatial, solo, dans le navigateur.
Le joueur part d'une concession minière unique et devient une puissance
commerciale qui exploite les guerres entre factions sans jamais les mener.

**État actuel : Phase 2 terminée** — au monde vivant de la Phase 1 (univers
procédural + économie offre/demande qui tourne en continu) s'ajoute le
joueur : crédits, vaisseau, voyage en temps réel, achat/vente qui déplacent
les prix, progression par prestige et tiers de marché, connaissance
périssable des marchés, concession améliorable, contrôles du temps.

## Lancer

```bash
npm install
npm start          # → http://localhost:3000
```

Au premier lancement, l'univers est généré et persisté dans `nexus-trade.db`
(SQLite), et une nouvelle partie commence : vaisseau et concession minière
sur un avant-poste minier (tier 1). Les lancements suivants reprennent la
même partie.

```bash
npm run verify     # vérification bout en bout sans serveur : économie,
                   # commerce, voyage, tiers, connaissance (10+ ticks simulés)
```

Variables d'environnement : `PORT` (défaut 3000), `TICK_MS` (défaut 5000),
`NEXUS_DB_PATH` (défaut `nexus-trade.db`).

Nouvel univers + nouvelle partie sans supprimer le fichier :

```bash
curl -X POST localhost:3000/api/admin/regenerate                  # seed aléatoire
curl -X POST localhost:3000/api/admin/regenerate \
     -H 'Content-Type: application/json' -d '{"seed": 42}'        # seed précise
```

## Comment on joue (boucle Phase 2)

1. Votre concession extrait du minerai à chaque tick (25/tick au niveau 1).
   À quai chez vous : **Charger la soute**. Le marché local est saturé de ce
   minerai (la planète en extrait aussi) — le vendre sur place rapporte peu.
2. Regardez la carte : les systèmes brillants sont connus, les éteints non.
   Les **rumeurs de quai** donnent les prix des systèmes voisins (avec
   retard) ; les **relevés** s'achètent pour les systèmes lointains.
3. **Voyagez** (la durée et le carburant dépendent de la distance — le monde
   continue de tourner pendant le trajet) et vendez où c'est cher. Vos
   ordres **déplacent les prix** : un gros volume écrase son propre marché.
4. Le **profit** construit votre **prestige**, qui ouvre les marchés des
   mondes plus riches (T2 ≥ 50 M hab., T3 ≥ 500 M) — ou achetez une
   **licence** pour griller l'étape. Les gros mondes = les gros volumes.
5. Réinvestissez : améliorer la concession (×2,4 puis ×2,5 d'extraction),
   et plus tard la flotte (Phase 3).

Contrôles du temps dans le bandeau : pause / ×1 / ×2 / ×4 et
**→ arrivée** pendant un transit.

## Ce qui est implémenté

**Phase 1 — le monde** (`server/universe/`, `server/economy/`)
- 60-100 systèmes en 2D, 3-6 planètes chacun, 6 biomes, génération 100 %
  déterministe par seed (PRNG mulberry32), distances précalculées
- 14 ressources sur 3 tiers, chaînes de production en data (`data/`)
- Tick (5 s, configurable) : extraction → industrie (bornée par les stocks
  d'entrée) → consommation civile → prix par stock cible
  (`base × (cible/stock)^élasticité`, borné, lissé) ; historique 120 ticks
- Moteur économique pur (ni Express ni DOM), DB injectée, testable en
  `:memory:`

**Phase 2 — le joueur** (`server/player/`)
- Crédits, prestige, vaisseau (soute 250, réservoir 400, vitesse 150 u/tick)
- Voyage en temps réel : durée = distance/vitesse, carburant consommé au
  départ, amarrage automatique à l'arrivée ; saut intra-système quasi gratuit
- Commerce avec **impact marché** : prix unitaire au stock médian
  (glissement), stock du marché modifié, prix déplacé immédiatement ;
  aperçu du glissement avant de confirmer
- **Tiers de marché** : T1 < 50 M hab. ouvert à tous, T2 et T3 exigent du
  prestige (200 / 1000) ou une licence (5 000 / 25 000 cr) ; le
  ravitaillement en carburant reste un service portuaire ouvert à tous
- **Prestige** = profits réalisés (1 pt / 100 cr de marge) + 25 pts par
  nouveau partenaire commercial — le volume à perte ne compte pas
- **Connaissance périssable** : prix servis par l'API seulement s'ils sont
  connus (visite = données complètes, rumeurs de quai = prix sans stocks
  des systèmes < 250 u, relevés achetés à distance) ; chaque donnée est
  datée et la carte grise les systèmes selon la fraîcheur
- Concession : extraction continue dans un entrepôt borné, chargement en
  soute à quai, 3 niveaux (25 → 60 → 150/tick)
- Horloge contrôlable : pause / ×1 / ×2 / ×4, saut jusqu'à l'arrivée
  (persisté en DB)

**UI** (`public/`, vanilla, zéro dépendance)
- Carte canvas : brouillard de connaissance (opacité par fraîcheur),
  vaisseau et ligne de route, infobulles
- Panneau : marché en direct à quai (commerce au clic, formulaire d'ordre
  avec aperçu), données datées à distance, boutons voyage/licence/relevé,
  bloc concession, journal de bord
- HUD : crédits, prestige (et prochain palier), soute, carburant, position,
  contrôles du temps

## API

| Endpoint | Rôle |
|---|---|
| `GET /api/universe` | systèmes, positions, planètes (+ tier) |
| `GET /api/planet/:id` | fiche publique ; détails économiques si à quai |
| `GET /api/market/:planetId` | direct si à quai (+ historique), sinon dernières données connues datées |
| `GET /api/state` | tick, seed, vitesse, compteurs |
| `GET /api/player` | crédits, prestige, tiers, vaisseau, cargo, concession |
| `GET /api/knowledge` | fraîcheur de la connaissance par système |
| `GET /api/trade/preview` · `POST /api/trade` | aperçu (glissement) et exécution d'ordre |
| `POST /api/refuel` | plein de carburant au prix du marché local |
| `POST /api/licence` | achat de licence T2/T3 |
| `GET /api/travel/preview` · `POST /api/travel` | coût d'un trajet et départ |
| `POST /api/concession/collect` · `/upgrade` | chargement en soute, amélioration |
| `GET /api/intel/preview` · `POST /api/intel` | relevé de marché d'un système distant |
| `POST /api/time` · `POST /api/time/skip` | vitesse de simulation, saut jusqu'à l'arrivée |
| `POST /api/admin/regenerate` | nouvel univers + nouvelle partie (dev) |

Validation des entrées aux frontières (400/403/404), erreurs en français.

## Architecture

```
├── server/
│   ├── index.js              # Express + horloge de simulation contrôlable
│   ├── simulation.js         # un tick complet : économie + concession + arrivées
│   ├── config.js             # tous les réglages (tick, pricing, joueur, tiers)
│   ├── db.js                 # init SQLite (better-sqlite3) + schéma
│   ├── universe/             # PRNG seedé + génération procédurale
│   ├── economy/              # pricing pur + moteur de tick économique
│   ├── player/               # state, trade, travel, knowledge, concession
│   └── routes/api.js         # endpoints REST
├── data/                     # ressources, recettes, biomes (data pur)
├── public/                   # UI vanilla (HTML/CSS/JS)
└── scripts/verify.js         # vérification bout en bout sans serveur
```

Moteur, générateur et modules joueur reçoivent l'instance DB en paramètre :
tout tourne tel quel sur une base `:memory:` (c'est ce que fait
`scripts/verify.js`).

## Notes de conception

- **Marchés fermés entre eux** : sans PNJ marchands (Phase 3), les
  déséquilibres entre planètes persistent — ce sont les gradients de prix
  que le joueur apprend à exploiter. La concurrence viendra les lui disputer.
- **Petits marchés peu profonds** : l'impact prix limite naturellement les
  volumes sur les avant-postes ; accéder aux tiers supérieurs, c'est
  accéder à la profondeur. La progression d'échelle est économique, pas
  artificielle.
- **L'information est une ressource** : les prix lointains sont vieux,
  incomplets ou payants. Le modèle de prix étant invariant d'échelle
  (ratios), les volumes pourront croître de plusieurs ordres de grandeur
  sans changer la formule.

## Reste à faire (Phase 3+)

- Factions et royaumes : territoires, réputation par faction, contrats en
  gros au niveau de la faction (tier 4)
- Marchands PNJ et flux commerciaux statistiques (simulation pyramidale :
  agents pleins / flux / matérialisation à la demande) ; état de simulation
  en mémoire avec sauvegarde différée
- Guerres et embargos comme chocs économiques exploitables
- Flotte multiple, automatisation de routes, drones d'exploration
- Arbre technologique : transformation sur site à la concession (Phase 4)
- Graphes de prix dans l'UI (l'historique est déjà exposé), SSE à la place
  du polling
