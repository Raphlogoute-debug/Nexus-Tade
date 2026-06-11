# Nexus Trade

Jeu de simulation économique et politique spatial, solo, dans le navigateur.
Le joueur part d'une concession minière unique et devient une puissance
commerciale qui exploite les guerres entre factions sans jamais les mener.

**État actuel : Phase 7 terminée** — l'usine tourne sans vous : des
**routes logistiques** (circuits d'étapes avec actions : charger/déposer à
vos concessions, acheter/vendre au marché) parcourues en boucle par les
vaisseaux assignés. Combinées à l'industrie de la Phase 6 (technologies,
ateliers, concessions multiples), à la flotte sans plafond limitée par son
entretien, et aux guerres de la Phase 4 : extraire → transformer →
distribuer → vendre, en continu, pendant que vous chassez l'opportunité.

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
npm run bench      # banc d'essai : coût d'un tick sur disque, partie chargée
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

**Phase 3 — le monde habité** (`server/factions/`, `server/npc/`)
- **Factions** : 6-9 royaumes générés (capitale = grand monde, territoire =
  systèmes dans le rayon de la capitale, le reste = Frange indépendante),
  visibles sur la carte (halos colorés, losange sur les capitales)
- **Logistique interne** : des convois (flux statistiques datés, pas des
  vaisseaux simulés un à un) équilibrent les marchés membres — le stock
  voyage réellement, donc il sera interceptable (blocus, piraterie)
- **Chantiers navals** : chaque capitale construit sa flotte en consommant
  modules, pièces et carburant SUR SON MARCHÉ — loi du minimum : couper
  l'approvisionnement paralyse la construction et fait chuter la
  disponibilité de la flotte (vérifié par `npm run verify`). C'est le
  levier que les guerres de la Phase 4 viendront encaisser.
- **Marchands PNJ** (~1 pour 2 systèmes) : achètent bas, voyagent, vendent
  haut, sur les mêmes marchés et avec le même impact prix que le joueur ;
  ils resserrent les écarts et comblent partiellement les ruptures
- **Besoins** : demande civile élastique aux prix (on se rationne quand
  c'est cher), indice d'approvisionnement par planète (besoins vitaux),
  démographie qui suit — une planète affamée se vide
- **Contrats de faction (tier 4)** : une pénurie stratégique durable à la
  capitale déclenche un appel d'offres (gros volume, prix premium, gros
  prestige) ; accessibles avec 1 500 prestige + 2 partenaires dans la
  faction — on traite avec le royaume, pas avec une planète

**Phase 4 — les guerres** (`server/factions/diplomacy.js`, `war.js`, `standing.js`)
- **Diplomatie** : relations par paire de factions qui dérivent (les
  voisins se frottent) ; sous −60, déclaration de guerre ; fronts =
  systèmes frontaliers des deux camps
- **Résolution par l'économie** : force effective = flotte × disponibilité
  (donc entretien réellement payé) ; attrition proportionnelle à la force
  adverse ; les fronts basculent selon le rapport de force et les systèmes
  changent de mains à ±1 ; paix par capitulation (flotte < 35 % de
  l'initiale) ou enlisement
- **Effort de guerre** : chantier ×2, entretien ×1,6 — la demande en
  matériel explose, les contrats passent au premium ×1,6 avec seuil abaissé
- **Blocus** : les convois d'un belligérant touchant un front sont
  interceptés à 40 % — on peut affamer une capitale
- **Réputation par faction** (−100..+100) : vendre du matériel stratégique
  à un belligérant améliore sa réputation chez lui et la dégrade chez son
  ennemi (renseignement) ; sous −20, saisie douanière de la cargaison
  stratégique aux fronts ; sous −50, liste noire (marchés fermés) ; les
  contrats exigent une réputation non hostile
- **Fil d'événements** : guerres, conquêtes, traités, saisies — déroulés
  dans le journal de bord, carte mise à jour (fronts en anneau rouge
  pointillé, territoires recolorés après conquête)

**Phase 5 — la compagnie** (`server/player/shipyard.js`, `automation.js`)
- **Flotte** : 3 classes (Navette 100/220, Cargo 250/150, Vraquier 700/100 —
  soute/vitesse), achat aux chantiers civils des mondes T2+, 8 vaisseaux max,
  toutes les commandes (commerce, voyage, plein, contrats) ciblent le
  vaisseau sélectionné dans la barre de flotte
- **Capitaines automatiques** : un vaisseau passé en AUTO achète bas,
  voyage, vend haut dans sa région — via les mêmes fonctions que vous
  (executeTrade/startTravel), donc avec vos tiers, licences, listes noires ;
  profits, prestige et réputation vous reviennent ; il gère son carburant
  et rafraîchit votre connaissance des marchés en se déplaçant
- **Catalogue étendu** : 10 brutes, 8 intermédiaires, 5 finies — nouvelles
  chaînes (silicium→céramiques→composants avancés, épices→médicaments,
  métaux précieux+polymères→biens de luxe) et nouveaux besoins civils ;
  les sauvegardes existantes reçoivent les marchés manquants au lancement
- **Graphes de prix** : sparkline des 60 derniers ticks dans le formulaire
  d'ordre (l'historique servait déjà l'API)

**Phase 6 — l'industrie joueur** (`server/player/tech.js`, `concession.js`)
- **Arbre technologique** (`data/technologies.js`) : 10 recherches en
  crédits — 7 filières d'atelier (Métallurgie → … → Industrie quantique,
  avec prérequis) et 3 effets permanents (Forage profond +50 %
  d'extraction, Entrepôts ×2, Prospection planétaire)
- **Ateliers sur site** : chaque concession a un entrepôt multi-ressources
  borné ; l'extraction y entre, les ateliers y transforment (cadence fixe,
  loi du minimum sur les entrées ET la place), le joueur charge/décharge
  sa soute — acheter du cuivre ailleurs pour nourrir sa fonderie
  d'alliages, et revendre à coût d'acquisition nul (profit pur → prestige)
- **Concessions multiples** : jusqu'à 5 sites (prix doublant), chacun
  extrayant la ressource phare de son biome — un site à hélium-3 sur une
  géante gazeuse alimente votre usine d'antimatière
- **Chaînes profondes** : antimatière (hélium-3 + cristaux), puces
  quantiques (silicium + métaux précieux), moteurs à saut (480 cr/u) —
  consommés par les grands mondes, produits par les seuls industriels
  équipés
- Migration douce : l'ancienne concession unique devient le premier site,
  entrepôt compris

**Phase 7 — les routes logistiques** (`server/player/routes.js`)
- Une route = un circuit d'étapes, chaque étape = une planète + des
  actions : **charger** (entrepôt → soute), **déposer** (soute →
  entrepôt), **acheter**, **vendre** — ressource précise ou « tout »,
  quantité précise ou « max »
- Les vaisseaux assignés (mode ROUTE) bouclent : exécution des actions à
  quai, cap sur l'étape suivante, plein automatique ; un échec d'action
  (entrepôt plein, marché fermé) est sauté, le circuit continue ; le
  découvert cloue le vaisseau jusqu'à régularisation
- Toutes les actions passent par les fonctions joueur habituelles : tiers,
  licences, listes noires, impact prix, prestige
- Flotte sans plafond de gameplay : **l'entretien par vaisseau par tick**
  est la vraie limite (découvert = flotte à quai) ; testé à 100 vaisseaux
  (204 ms/tick)

**UI** (`public/`, vanilla, zéro dépendance)
- Carte canvas : territoires de faction (halos), capitales (losanges),
  brouillard de connaissance (opacité par fraîcheur), vaisseau et ligne de
  route, infobulles
- Panneau : marché en direct à quai (commerce au clic, formulaire d'ordre
  avec aperçu), données datées à distance, boutons voyage/licence/relevé,
  bloc concession, panneau faction (flotte, tensions stratégiques,
  contrats avec livraison), journal de bord
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
| `GET /api/factions` · `GET /api/faction/:id` | royaumes : territoire, flotte, diplomatie, guerre, réputation, contrats |
| `GET /api/contracts` · `POST /api/contracts/:id/deliver` | appels d'offres de faction et livraison |
| `GET /api/events?since=id` | fil d'événements du monde (guerres, conquêtes, saisies, flotte) |
| `POST /api/ships/buy` · `POST /api/ships/:id/mode` | achat de vaisseau, bascule manuel/auto |
| `GET /api/tech` · `POST /api/tech/research` | arbre technologique et recherche |
| `POST /api/concession/collect` · `/deposit` · `/upgrade` | transferts entrepôt↔soute, amélioration |
| `POST /api/concessions/buy` · `POST /api/concessions/:id/workshops` | nouveau site, installation d'atelier |
| `GET/POST /api/routes` · `DELETE /api/routes/:id` · `POST /api/ships/:id/route` | routes logistiques et assignation |
| `POST /api/admin/regenerate` | nouvel univers + nouvelle partie (dev) |

Toutes les commandes de vaisseau acceptent un `shipId` (défaut :
vaisseau-amiral).

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

- **Une seule économie pour tout le monde** : joueur, marchands PNJ,
  convois de faction, chantiers navals et contrats passent par les mêmes
  marchés et les mêmes règles d'impact prix (`economy/market.js`). C'est ce
  qui rend les chaînes de dépendance réelles : un royaume privé de modules
  ne construit plus, quelle que soit l'origine de la rupture.
- **Simulation pyramidale** : agents pleins (marchands nommés) pour ce qui
  se voit, flux statistiques (convois) pour la masse, loi du minimum
  partout. Des milliers de vaisseaux *implicites* sans en simuler un seul
  inutilement.
- **Petits marchés peu profonds** : l'impact prix limite naturellement les
  volumes sur les avant-postes ; accéder aux tiers supérieurs, c'est
  accéder à la profondeur. La progression d'échelle est économique, pas
  artificielle. Le modèle de prix étant invariant d'échelle (ratios), les
  volumes pourront croître de plusieurs ordres de grandeur sans changer la
  formule.
- **L'information est une ressource** : les prix lointains sont vieux,
  incomplets ou payants.
- **Performances** (`npm run bench`, sur disque, partie chargée) : ~106 ms
  par tick en médiane, max 225 ms — 2 % du budget de 5 s, ~9 ticks/s en
  accéléré. Recettes : une seule transaction par tick, WAL +
  synchronous NORMAL, cache global de requêtes préparées, écritures
  limitées aux marchés qui bougent, historique échantillonné (1/2 ticks,
  prix vivants seulement), voisinages stellaires précalculés et scans
  partagés pour les PNJ et la flotte.

## Reste à faire (Phase 8+) — cap sur l'économie et le joueur

- **Parts d'industries planétaires** : investir dans les industries des
  autres mondes et toucher des dividendes
- **Encore des chaînes** : ressources exotiques rares par biome, recettes
  alternatives (rendements différents selon la filière)
- Contrebande (franchir blocus et listes noires), prêts de guerre
- SSE à la place du polling ; état de simulation en mémoire si un jour
  les ~100 ms/tick ne suffisent plus ; événements économiques (repoussés
  à la demande du joueur)
