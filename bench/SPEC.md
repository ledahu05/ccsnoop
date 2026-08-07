# Spec — banc de tuning ccsnoop

**Statut** : verrouillé, prêt à handoff impl. Produit par
[B8](https://github.com/ledahu05/ccsnoop/issues/57), assemblage des sept résolutions de la carte
[#46](https://github.com/ledahu05/ccsnoop/issues/46). Aucune décision n'est prise ici : ce document
met à plat B1–B7 et fait tomber les contradictions résiduelles. Chaque affirmation porte sa source.

**Objet** : un harness de dev qui, sans intervention humaine, monte 7 environnements isolés, lance
7 vraies sessions `claude -p` à travers le proxy ccsnoop, et compare **avant/après tuning** en
octets par bucket et en tokens de cache — prouvant que les leviers de `omniris_tuning.md` réduisent
bien ce qui part sur le fil. Effet de bord assumé : couverture end-to-end du chemin nominal
`start → init → claude -p → status → stop → report`.

**Ce que le banc prouve** : le **mécanisme** et l'**ordre de grandeur** d'un levier. Pas l'économie
absolue sur omniris — non reproductible par construction (B4).

---

## 0. Environnement de référence et prérequis

| Élément | Valeur | Source |
|---|---|---|
| Claude Code | `2.1.220`, linux-x64, `sdk-cli` | B1, B2, B6 |
| ↳ dérive constatée | poste de dev à `2.1.224` au 2026-08-07. Les lectures du levier 5 (`skillOverrides`, exemption plugin, `disableBundledSkills`) ont été re-lues sur les **deux** versions : code identique, chaînes de schéma byte-identiques — [#115](https://github.com/ledahu05/ccsnoop/issues/115), [note](../docs/research/skill-overrides-name-only.md) | #115 |
| Compte | `authMethod: claude.ai`, abonnement (pas `ANTHROPIC_API_KEY`) | B1 |
| Modèle | **`claude-haiku-4-5-20251001`** — ID daté, pinné (pas l'alias) | B2, B6 |
| Régime | `ENABLE_TOOL_SEARCH=true`, identique aux 7 bras | B7 |
| ccsnoop | `readUsage` gunzippe (`src/report.js:126`) — [#53](https://github.com/ledahu05/ccsnoop/issues/53) **fermé** | ci-dessous §7 |
| ccsnoop | `report --all` honore `CCSNOOP_HOME` — [#54](https://github.com/ledahu05/ccsnoop/issues/54) **fermé** | ci-dessous §7 |

**NON-NÉGOCIABLE de la carte** : *jamais re-tokenizer*. Les tailles sont des **octets**
(`Segment.bytes`, `Anatomy.*`) ; les **tokens** viennent uniquement de `usage` capturé (`readUsage`).
Aucun ratio de conversion octets↔tokens n'est jamais affiché.

**Le driver n'est pas un sous-agent Claude Code par construction, mais ce n'est pas une garantie
d'environnement** : B1 a vu le loopback TCP bloqué dans un sous-agent CC (le driver pendrait
indéfiniment, en silence) ; B6 a capturé deux vraies sessions depuis un sous-agent. La panne doit
donc être **bruyante** — d'où la garde de joignabilité de §2, étape 6.

---

## 1. Forme (B4, B7)

**Script de dev hors distribution.** `scripts/bench/run.mjs`, absent de `files` dans
`package.json`. Précédent maison : `docs/research/probes/base-url-path-prefix-probe.mjs`. Pas de
sous-commande `ccsnoop bench`, même cachée : le banc paie de vrais tokens, recopie
`~/.claude/.credentials.json` (0600) et écrit des `CLAUDE_CONFIG_DIR` jetables. Corollaire : ni
`--help` à tenir, ni semver, ni engagement de compat.

**Trois étapes séparées, sans reprise automatique** — le plancher de bruit de 0 octet (B2) rend une
capture **définitive** : c'est un artefact, pas un échantillon. Rien à moyenner, rien à re-valider
par cache (dont l'échec silencieux reproduirait le faux gain de B1).

```
node scripts/bench/run.mjs arm  <id>    # capture UN bras, le persiste
node scripts/bench/run.mjs diff <run>   # relit le disque, écrit diff.json + table — coût zéro
node scripts/bench/run.mjs teardown <run>  # hygiène : stop, init --undo, rm -rf
```

Pas de wrapper `all` : un bras cassé ne coûte que lui.

**Le témoin est désigné par le manifeste (`arm-00`), pas par un argument.** `diff <run>` lit **tout**
le dir de run — témoin + N bras — ce qui est la seule façon d'exprimer la ligne « interaction »,
globale au run.

### Manifeste — un bras est déclaré en donnée

`bench/manifest.json`, versionné. Trois champs par bras : `settings` (le levier), `env` (le
routage — B1 : on ne route jamais par un fichier de settings), `seed` (le contenu de config-dir
gelé — B7 : L6 n'a **aucune** expression en réglage).

```json
{
  "prompt": "Read the file FIXED.txt and reply with only its first word.",
  "model": "claude-haiku-4-5-20251001",
  "turns": 2,
  "cwd": "bench/fixture",
  "arms": [
    { "id": "arm-00", "label": "témoin",        "seed": "loaded", "settings": { "hooks": { "SessionStart": [ /* cat ./hook-persona.txt */ ] } }, "env": {} },
    { "id": "arm-01", "label": "L1 tools deny", "seed": "loaded", "settings": { "…témoin…": true, "permissions": { "deny": ["Workflow"] } }, "env": {} }
  ]
}
```

- `id` de **largeur fixe**, `/^arm-\d\d$/` — le chemin du `CLAUDE_CONFIG_DIR` fuit dans `system#2`
  (B6), donc deux bras nommés différemment porteraient un biais silencieux en octets.
- `label` **ne touche jamais un chemin** — ni `CLAUDE_CONFIG_DIR`, ni le dir de run. Il ne vit que
  dans `diff.json` et dans la table.
- **`turns` décrit les POSTs produits par une seule invocation de `claude -p`, pas un nombre
  d'invocations.** B2 a mesuré 2 POSTs pour une invocation du prompt canonique (le `Read` forcé
  produit le second). Lancer `claude -p` deux fois donnerait un tour 1 **chaud** au second lancement
  et détruirait la lecture de cache spécifiée en §4.
- `env` est **identique aux 7 bras** : `ANTHROPIC_BASE_URL` (posé par `init`, relu et réinjecté dans
  l'env du process) + `ENABLE_TOOL_SEARCH=true`. La « minimalité » du témoin ne porte que sur
  `settings`.

### Fixture gelée (B7)

Commitée sous `bench/fixture/`, **matérialisée hors du repo** avant le run (§2, étape 3).

```
bench/fixture/
  CLAUDE.md            8 192 o exactement   (L3, scope projet du cwd)
  hook-persona.txt     8 192 o exactement   (L2, injecté par `cat ./hook-persona.txt`)
  FIXED.txt            contenu fixe, lu par le prompt canonique (B2)
  .mcp.json            1 serveur stdio → mcp-stub.mjs
  mcp-stub.mjs         64 outils, noms courts, node nu, zéro réseau  (régime, plus un levier — #78)
  seeds/loaded/agents/ 8 agents, description d'une ligne             (L6)
  seeds/bare/          (vide)
```

**Aucun fichier de settings dans la fixture** : les settings du bras vivent dans son
`CLAUDE_CONFIG_DIR` (scope user, B1). Le `.claude/settings.local.json` écrit par `ccsnoop init` dans
le cwd est identique pour tous les bras et **hors du périmètre** de l'assertion d'octets.

**Calibration des comptes** (64 outils, 8 agents) : un run une fois, comptes gelés ensuite. Les
tailles de listing obtenues sont enregistrées en **provenance**, pas en assertion — elles sont
rendues par CC, pas écrites par nous.

---

## 2. La séquence d'un bras, de bout en bout

Ordre exact. La colonne **Fatal** dit si l'échec de l'étape termine le run avec `exit ≠ 0` (voir §5
pour la table consolidée des codes de sortie).

### Étapes de run (idempotentes, exécutées au premier `arm` d'un run donné)

| # | Étape | Fatal | Source |
|---|---|---|---|
| 1 | **Pré-flight du manifeste** — JSON bien formé ; clés de settings connues ; tous les `id` matchent `/^arm-\d\d$/` et sont de largeur **identique** ; chaque `seed` existe dans `bench/fixture/seeds/` | **oui** | B4, B1, B3 |
| 2 | Créer le dir de run `$TMPDIR/ccsnoop-bench/<horodatage>/` et son `ccsnoop-home/` | oui | B1 |
| 3 | **Matérialiser la fixture** : copie verbatim de `bench/fixture/` (hors `seeds/`) vers `<run>/cwd/`, puis assertion d'**égalité octet à octet** avec la source commitée **et** qu'**aucun répertoire ancêtre de `<run>/cwd` ne porte `CLAUDE.md` ni `.claude/`** | **oui** | B7 |
| 4 | `git init` dans `<run>/cwd` — sans commit, sans remote. Le cwd devient son **propre** top-level git, donc `init` exerce aussi la branche gitignore (couverture E2E) sans réintroduire d'ancêtre ccsnoop | non (best effort) | B1 §3, réconcilié avec B7 §6 |
| 5 | **Danse de ports** : `ccsnoop start --port <libre> --home <run>/ccsnoop-home` → `ccsnoop stop` → (`cd <run>/cwd && ccsnoop init --home <run>/ccsnoop-home`) → `ccsnoop start --port <même port libre>` → **attendre la socket** (`start` est détaché : premier essai `ECONNREFUSED`) | oui | B6 |
| 6 | **Garde de joignabilité** : depuis un **enfant spawné** (pas le process du driver), `GET <baseUrl>/api/hello` doit rendre **200**. Un 502 = route inconnue du daemon (B6 y a perdu deux `claude -p` à 0 token) | **oui** | B6 |
| 7 | Relire `<run>/cwd/.claude/settings.local.json` et extraire `ANTHROPIC_BASE_URL` — le **port réellement pris** par ce daemon-ci, avec le token dérivé du cwd. Vérifier que la route est dans `<run>/ccsnoop-home/routes.json`. Ce couple part dans l'`env` de tous les bras | oui | B1, B5 |

`init` et `start` reçoivent **le même `--home`**, sinon le daemon lit un `routes.json` sans route et
ne capture rien (B1 §5). Le daemon, `init` et le cwd sont **run-scoped** : le cwd est partagé par
les 7 bras (B4), donc il y a **une** route et **un** `init` par run. Un `arm <id>` ultérieur sur le
même run réutilise l'infra en place ; les étapes 1–7 sont sautées si le dir de run existe déjà et
que la garde 6 repasse au vert.

### Étapes par bras

| # | Étape | Fatal | Source |
|---|---|---|---|
| 8 | Créer `<run>/<id>/.claude/` et y écrire `settings.json` = les `settings` du bras | oui | B1 |
| 9 | **Seeding** : copier `bench/fixture/seeds/<seed>/` dans `<run>/<id>/.claude/` (donc `agents/` pour `loaded`, rien pour `bare`) | oui | B7 |
| 10 | **Copie du secret** : `install -m 600 ~/.claude/.credentials.json <run>/<id>/.claude/` — les creds OAuth ne survivent **pas** à l'isolation (`{"loggedIn": false}`, exit 1) | oui | B1 §2 |
| 11 | **Pré-vol `system/init` sur le répertoire même que le run live utilisera** : `claude` avec `CLAUDE_CONFIG_DIR=<run>/<id>/.claude` et un port mort, lire l'événement `system/init` (zéro token, émis avant le POST). Compter les outils. Meilleur que `claude doctor` : il compte. Sert à attraper le settings **silencieusement ignoré** sous `-p` | oui | B1 §1, B6 |
| 11b | **Santé du `.mcp.json`** : `claude mcp list` sur le même `CLAUDE_CONFIG_DIR` (zéro token — il fait le handshake, pas de POST). Chaque serveur déclaré par `bench/fixture/.mcp.json` doit être **`✔ Connected`**, sauf ceux qu'un bras désactiverait délibérément, pour lesquels « connecté » signifierait que la clé n'a pas pris — cas hypothétique depuis #78, aucun bras du manifeste ne désactive. L'étape 11 est **aveugle** ici : `system/init` précède le handshake (statut `pending` dans tous les cas) et `ENABLE_TOOL_SEARCH` diffère les outils du stub hors de `event.tools`. Sans ce garde, un serveur project-scoped resté `⏸ Pending approval` sous `-p` produit une capture propre où **L4 mesure le retrait de rien** — et seul un bras levier l'aurait vu, jamais le témoin. D'où `enabledMcpjsonServers` épinglé sur les 7 bras, comme `ENABLE_TOOL_SEARCH` : c'est du **régime** (ADR-0003 D1), et ce garde survit à la disparition du levier L4 qu'il avait été écrit pour protéger | oui | #72 |
| 12 | **`claude -p`** : `claude -p "<prompt>" --model claude-haiku-4-5-20251001 --permission-mode bypassPermissions`, avec `CLAUDE_CONFIG_DIR=<run>/<id>/.claude`, cwd `<run>/cwd`, `ANTHROPIC_BASE_URL` + `ENABLE_TOOL_SEARCH` dans l'env du process. `bypassPermissions` ne neutralise pas `deny` (B6) | non par lui-même — voir 13 | B2, B1, B6 |
| 13 | **Preuve de session** = **au moins un exchange capturé**, jamais `exit 0`. Un lancement cassé (creds, settings malformé) sort **exit 0 sans rien capturer** | **oui** | B5 |
| 14 | `ccsnoop status --home <run>/ccsnoop-home` : nombre de routes = 1, uptime > 0 | oui | B5 |
| 15 | `ccsnoop report --root <run>/cwd/.ccsnoop --session <session_id>` — exercé pour la couverture E2E (B5) ; le HTML produit est jeté. ⚠ **Doit passer AVANT l'extraction** : `init` enregistre `routes[token].dir = <cwd>/.ccsnoop` et les captures vivent en `<dir>/sessions/<session_id>/` (`src/init.js:155`), donc extraire d'abord priverait `report` de sa cible. ⚠ **`report` n'accepte pas `--home`** (`bin/ccsnoop.js:41` appelle `runReport(args)` sans le home) : passer `CCSNOOP_HOME` dans l'env, ou s'en tenir à `--root`, jamais `--all` | oui | B5, B1 §5, #54 |
| 16 | **Extraction** : déplacer le session-dir frais de `<run>/cwd/.ccsnoop/sessions/<session_id>/` vers `<run>/<id>/capture/`. C'est cette étape qui crée `capture/` — les étapes 17–19 en dépendent | **oui** (capture absente) | B4 |
| 17 | **Lecture du modèle** : `loadSession('<run>/<id>/capture', '<session_id>')` en process. Seam unique — pas de HTML, pas de re-parse de `requestBlob` | oui | B3 |
| 18 | **Observations dures** du chemin nominal, sur les blobs de `<run>/<id>/capture/` : le `HEAD /<token>/api/hello` **précède** le POST dans `manifest.jsonl` (préflight Bun réel) ; le blob de réponse porte la **signature gzip `1f 8b`** | **oui** (gzip non observé) | B5 |
| 19 | **Gardes d'intégrité du levier** — voir §4 | **oui** | B7 |
| 20 | `install -m 600 /dev/null` non : **supprimer** `<run>/<id>/.claude/.credentials.json` | oui | B1 |
| 21 | Écrire `<run>/<id>/arm.json` (modèle extrait + méta) et `<run>/provenance.json` (version CC, version ccsnoop, port, horodatage, comptes de listing calibrés) — **la provenance est obligatoire** : le build CC bouge le contenu à Δ0 octet, un run sans version CC n'est pas comparable | oui | B4, B2 |

### Teardown (`run.mjs teardown <run>`, et `trap … EXIT INT TERM` du driver)

```bash
ccsnoop stop --home "$RUN/ccsnoop-home"          || true   # exit 0 si déjà arrêté
( cd "$RUN/cwd" && ccsnoop init --undo --home "$RUN/ccsnoop-home" ) || true
rm -rf "$RUN"/arm-*/.claude/.credentials.json             # ⚠ secret, idempotent
```

`init --undo` est dans le banc en **hygiène**, pas en assertion : un bras qui laisse
`ANTHROPIC_BASE_URL` derrière lui empoisonne le suivant. La restauration exacte reste couverte par
`test/init.test.js` (B5). Un `kill -9` du driver bat le trap ⇒ au démarrage, le driver balaie les
`$TMPDIR/ccsnoop-bench/*` orphelins et arrête tout daemon dont il trouve le pidfile (B1 §5).

**Le banc ne touche jamais `~/.ccsnoop/routes.json` ni `~/.claude/`** — hors la lecture de
`~/.claude/.credentials.json` à l'étape 10.

**Ne pas paralléliser les bras** tant que la question ouverte de B1 (refresh du token OAuth sous
fichier de creds recopié) n'est pas tranchée. B6 a un point de donnée rassurant (deux bras
séquentiels n'ont pas invalidé les creds du dev), pas une garantie.

---

## 3. Les 7 bras (B3, B7)

Chaque bras = témoin **+ une seule clé soustractive** — sauf `arm-06` qui est témoin **+ seed
`bare`**, parce qu'**aucun réglage ne désactive les agent-types** sur le binaire v2.1.220 (B7 :
0 occurrence de `disableBundledAgents` / `agentOverrides` / `disabledAgents`).

| id | levier | knob ou seed | sentinelle d'intégrité | poids mesuré en amont |
|---|---|---|---|---|
| `arm-00` | témoin | hook déclaré + seed `loaded` | — (référence) | requête #1 ≈ 111 ko nu (B2) |
| `arm-01` | L1 tools | `permissions.deny` | diff d'ensembles de slots (noms d'outils built-in) | −35 916 o net pour 5 noms (B6) |
| `arm-02` | L2 hooks | `hooks.SessionStart: []` | chaîne littérale de `hook-persona.txt` | ⎫ |
| `arm-03` | L3 CLAUDE.md | `claudeMdExcludes` | chaîne littérale de `CLAUDE.md` | ⎪ ensemble dans `message#0` |
| `arm-05` | L5 skills | `disableBundledSkills` | diff d'ensembles de slots (skills bundled) | ⎪ 8 319 o |
| `arm-06` | L6 agents | **seed `bare`** | nom d'un agent du seed `loaded` | ⎭ 2 345 o |
| `arm-07` | `all` | toutes les clés + seed `bare` | les 3 sentinelles absentes | — |

> **Il n'y a pas de bras L4 — décision prise sur [#78](https://github.com/ledahu05/ccsnoop/issues/78),
> le levier MCP est déclaré inmesurable sous `-p`.** Le motif est mécanique : même serveur
> `✔ Connected` (étape 11b), les outils MCP **n'atteignent pas le fil avant le tour 3** — les
> tours 1 et 2 portent `The following MCP servers are still connecting … not yet available`. Or le
> manifeste épingle `turns: 2` et le diff de levier lit la **requête #1**, donc la sentinelle
> `mcp__<serveur>__t00` ne pouvait jamais être présente dans le témoin : `arm-04` échouait à
> l'étape 19 (§5) en mesurant le retrait de rien. L'alternative — allonger le prompt canonique
> jusqu'au tour 3 — est une décision §0 qui impose de **re-baseliner tous les octets** de cette
> table et de §4 dans une campagne payante complète ; prix jugé trop élevé pour un levier dont
> l'existence est couverte côté produit (`ccsnoop fine-tune`, [#74](https://github.com/ledahu05/ccsnoop/issues/74)).
> Le levier rejoint donc §9 comme non-objectif nommé, à côté de sa moitié « connectors claude.ai »
> déjà écartée. Le repère B2 de 22 919 o reste une mesure **amont** partagée L2/L3/L4 — jamais une
> mesure du banc. `enabledMcpjsonServers` reste épinglé sur les 7 bras comme **régime** (ADR-0003
> D1) et l'étape 11b reste fatale : le stub doit se connecter, on cesse seulement de prétendre
> le **peser**.

**Notes de lecture obligatoires dans la table de sortie** :

- **L6 est dimensionné en compte, pas en octets.** Sous `ENABLE_TOOL_SEARCH` un listing différé
  ne porte que des **noms** et *les schémas ne sont jamais envoyés* — le poids est fonction du
  **nombre** d'entrées. Repère B6 : ~29 o par nom différé. Donc la table **imprime le compte
  déclaré à côté du delta** (8 agents), sinon un lecteur lit « agents = petit levier » alors qu'il
  lit « la fixture a déclaré 8 agents ». (B7 §2) Le même raisonnement valait pour L4 et ses 64
  outils MCP ; il n'a plus de ligne où s'appliquer depuis #78.
- **Les agent-types bundled sont un plancher constant** présent dans tous les bras, y compris
  `arm-06` : le delta L6 mesure les agents **ajoutés**, jamais la totalité du bloc. (B7 §3)
- **Les skills bundled ne s'effondrent pas sous config-dir isolé** — elles viennent du binaire.
  C'est ce qui rend L5 mesurable sans rien geler. Garde : le listing skills du témoin doit être
  **non vide**, sinon L5 est un bras vide qui rapporterait « les skills ne coûtent rien ». (B7 §3)
- **8 192 o d'entrée ne donnent pas des lignes de base égales sur le fil.** Une injection
  `CLAUDE.md` et une injection `SessionStart` portent des **encadrements différents** (en-têtes,
  enveloppe `<system-reminder>`, annotations de chemin) — petits et constants par levier. La
  conclusion de **mécanisme** tient ; la lecture « inégalité 8 192 vs 8 192 = comportement CC pur »
  **non**. (B7, addendum 2)
- **`Tool(*)` se comporte comme un nom nu.** Un banc qui classe « nu vs scopé » sur la présence
  d'une parenthèse se trompe : le discriminant est le **contenu** du scope (vide ou `*` ⇒ retrait).
  (B6 §3)
- **Choisir les cibles de `arm-01` dans le `tools[]` observé du témoin**, pas dans une liste écrite
  à l'avance : dénier un outil **déjà différé** ne rend que ~29 o (0,13 % de ce que rend
  `Workflow`). `Workflow` seul = 37 % du bucket `tools`. (B6)

---

## 4. Métriques, seam et gardes (B3, B6, B7)

### Seam — `loadSession()`, et rien d'autre

```
loadSession(dir, id) → { exchanges[], waste, wasteConfig }
```

Par exchange, le banc lit :

| champ | source | usage |
|---|---|---|
| `anatomy.{system,tools,history,currentTurn,total}` | `computeAnatomy` | octets par bucket — l'axe bloat |
| `requestBytes` | taille du blob brut | contrôle de cohérence |
| `segments[]` (`slot`, `bytes`, `bucket`) | `segmentRequest` | attribution L1 par nom, diff de slots |
| `usage.{inputTokens,cacheRead,cacheCreation,outputTokens}` | `readUsage` | l'axe cache |

**Interdits explicites** : pas de scraping du HTML (`renderReport` est une vue) ; pas de re-parse de
`requestBlob` (que `loadSession` conserve pourtant) ; **jamais de re-tokenisation**. S'il manque une
donnée au banc, c'est un ticket produit — pas un contournement dans le banc.

**Cohérence** : `anatomy.total = system + tools + history + currentTurn`, ce qui **exclut** les clés
scalaires de haut niveau du corps (`model`, `max_tokens`, `metadata`, `stream`…). Donc
`anatomy.total < requestBytes`. Le banc rapporte **les deux** et ne présente jamais `anatomy.total`
comme « la taille de la requête ».

### Attribution — structurelle, pas textuelle

Le chiffre d'un levier est le **delta net de bucket entre son bras et le témoin**. Règle dure de B6
généralisée : **jamais une somme de schémas visés**. Denier `Bash` fait *revenir* `Glob` (981 o) +
`Grep` (3 640 o) ⇒ gain net 7 073 o, pas 11 694.

- Gain d'un levier = delta net vs témoin.
- Gain réel du tuning = delta de `arm-07`.
- **`Σ(bras) − all` est rapporté en ligne « interaction »**, jamais absorbé en silence.
- Tout slot **présent dans le bras et absent du témoin** est listé en ligne **« substitution »** sous
  le levier, avec ses octets.

**Le diff inter-bras se fait par clé de slot et par octets — jamais par hash.** B2 a mesuré trois
sources qui bougent le hash à Δ0 octet (`tool_use_id`, build CC, `session_id`) ; B6 a montré que
`system#2` change de **variante** par bras (churn à double sens nettant à +3 o mais déplaçant 45 o).
Le plancher `system` n'est **pas invariant entre bras**.

**Piège de bucket** : en `-p` turn 1, `messages` n'a qu'une entrée, donc `message#0` est le
**dernier** message ⇒ `segmentRequest` le classe en **`currentTurn`**, pas en `history`. Le delta
L2–L6 se lit donc sur `currentTurn` au tour 1, et le même bloc bascule en `history` au tour 2. **Le
banc lit chaque axe sur le tour où le bucket est défini ; il ne somme pas les tours.**

**Refusé** (et à ne pas réintroduire) : re-slicer `message#0` dans le banc (les marqueurs internes
sont un contrat **non documenté** de CC — un banc qui mente silencieusement est pire que pas de banc)
et sous-segmenter dans `src/waste.js` (modifie le produit sous test).

### Deux tours, et le coût de transition

| tour | ce qu'on lit | ce que ça donne |
|---|---|---|
| 1 | `anatomy` (octets/bucket), `segments` | gain bloat, net vs témoin |
| 1 | `usage.cacheCreation` | **coût de transition** — ligne à part |
| 2 | `usage.cacheRead`, `usage.inputTokens` | **régime stationnaire** — seul support du verdict cache |

**Le coût de transition n'est jamais soustrait du gain et jamais confondu avec le stationnaire.**
Son amortissement est laissé au lecteur : le *pricing* appartient à
[#36](https://github.com/ledahu05/ccsnoop/issues/36).

Pourquoi le tour 2 : le `cache_read` du tour 1 n'est pas causé par le run — il est causé par ce qui a
été écrit avant (B2 : run A écrit 29 367 tokens de préfixe inédit ; run B, préfixe byte-identique,
les relit intégralement et écrit 0). Corollaire de protocole : **l'ordre des bras et la répétition
d'un même bras sont des variables** ; rejouer un bras donne un tour 1 chaud.

**Un seul run par bras** : plancher de bruit 0 o sur la requête #1, 168 o sur la requête #2, contre
un signal ≈48 800 o. Rien à moyenner.

### Règle d'unité, opposable au format

Octets ← segments. Tokens ← `usage` **et seulement** `usage`. `usage` étant agrégé **par requête**,
un chiffre en tokens existe **par bras**, jamais par outil ni par segment — c'est précisément
pourquoi l'attribution est structurelle. Conséquences dures sur ce que `diff.json` **a le droit** de
contenir :

- Aucun champ token sous un bucket, un segment ou un nom d'outil.
- **Aucune colonne dérivée** genre octets-par-token, ni estimation de tokens depuis des octets :
  c'est la re-tokenisation déguisée.
- Chaque nombre porte son unité, et sa provenance est déductible de son emplacement (bucket ⇒
  octets/segments ; bras ⇒ tokens/`usage`).

**Hors verdict, en contexte** : ventilation par outil (`tool:<nom>`), `outputTokens` (dépend de ce
que le modèle répond, pas du tuning), `durationMs`, signaux `waste` (`bloatCount`, `flagship` —
sémantique de [#29](https://github.com/ledahu05/ccsnoop/issues/29), affichée sans être jugée).

### Gardes d'intégrité du levier (étape 19)

Deux gardes, complémentaires, toutes deux **fatales** :

1. **« Le knob a-t-il pris ? »** Si la requête #1 d'un bras levier est **byte-identique** à celle du
   témoin, le knob n'a **pas** pris ⇒ `exit ≠ 0` (intégrité), **pas** « levier à gain nul ». Fondé
   sur B1 (un settings malformé est *silencieusement ignoré* sous `-p`) + B2 (plancher de bruit
   0 octet).
2. **« Le knob a-t-il pris sur les bons octets ? »** La garde 1 n'attrape pas le knob appliqué aux
   *mauvais* octets — si `cat ./hook-persona.txt` échoue, CC injecte une **chaîne d'erreur** :
   témoin ≠ `arm-02`, garde 1 au vert, et L2 rapporte le poids d'un message d'erreur comme « le
   levier hooks ». Correctif : chaque actif écrit par la fixture porte une **sentinelle unique**
   (table §3), et l'intégrité assert **présente dans la requête #1 du témoin, absente dans celle du
   bras levier**. L1 et L5 n'en ont pas besoin : leurs noms (outils built-in, skills bundled) sont
   déjà des sentinelles fournies par CC — c'est le diff d'ensembles de slots.

Ces gardes **ne contredisent pas** la règle « exit 0 si le gain est nul ou négatif » (§5) : celle-ci
parle du **verdict** sur un knob qui a pris ; celles-ci parlent d'un knob jamais appliqué, ou
appliqué ailleurs. Un delta non nul mais petit, négatif ou contre-intuitif reste **exit 0**.

---

## 5. Codes de sortie — table consolidée

Le banc est un **banc de mesure, pas un test** : `exit ≠ 0` sur l'**intégrité de la mesure**, jamais
sur le chiffre.

| exit | cause | étape | source |
|---|---|---|---|
| ≠ 0 | manifeste invalide ; clé de settings inconnue | 1 | B4 |
| ≠ 0 | `id` de largeur non fixe ou inégale | 1 | B3, B6 |
| ≠ 0 | `seed` déclaré inexistant | 1 | B7 |
| ≠ 0 | fixture matérialisée ≠ source commitée (octet à octet) | 3 | B7 |
| ≠ 0 | un ancêtre du cwd porte `CLAUDE.md` ou `.claude/` | 3 | B7 |
| ≠ 0 | daemon injoignable depuis un **enfant spawné** (le 502 de B6) | 6 | B6 |
| ≠ 0 | settings rejeté au pré-vol `system/init` | 11 | B1 |
| ≠ 0 | serveur `.mcp.json` non connecté (ou connecté alors que le bras le désactive — cas hypothétique depuis #78, aucun bras ne désactive) | 11b | #72 |
| ≠ 0 | **zéro exchange capturé** (jamais `exit 0` de `claude -p` comme preuve) | 13 | B5 |
| ≠ 0 | capture absente / extraction impossible | 15 | B4 |
| ≠ 0 | **gzip non observé** sur le blob de réponse | 18 | B5 |
| ≠ 0 | requête #1 du bras **byte-identique** au témoin (knob non pris) | 19 | B7 |
| ≠ 0 | sentinelle du levier présente dans le bras (ou absente du témoin) — L1/L2/L3/L5/L6 ; aucune sentinelle L4 n'est déclarée (#78) | 19 | B7 |
| ≠ 0 | listing skills du témoin vide (L5 serait un bras vide) | 19 | B7 |
| ≠ 0 | provenance incomplète (version CC absente) | 21 | B4, B2 |
| **0** | mesure valide — **même si le gain est nul ou négatif** | — | B4 |
| **0** | run **dégradé** : axe cache indisponible, `degraded` renseigné | — | B4, B5 |

Deux raisons dures derrière « pas de seuil sur le chiffre », pas une préférence : un gain de levier
est un **delta net imprévisible** (`Bash` : 7 073 o, pas 11 694 — B6), donc un seuil octet codé
aujourd'hui casse au prochain build CC ; et ce que le banc *doit* attraper — le faux gain de B1,
settings silencieusement ignoré — est un échec d'**intégrité**, déjà couvert ci-dessus.

⚠ **« gzip non observé ⇒ fatal » et « axe cache indisponible ⇒ `degraded`, exit 0 » ne se
contredisent pas** : le premier porte sur les **octets bruts** du blob (signature `1f 8b`), le second
sur la **lisibilité de `usage`**. Le capteur gzip est ce qui a détecté #53 ; le garder dur est ce qui
fait que le banc se répare seul (B5). Depuis la fermeture de #53 (§7), `degraded` est un **repli
rare**, plus le régime attendu.

---

## 6. Sortie — `diff.json` canonique + table dérivée

Une source, deux lectures : le dev lit la table, un agent assert le JSON, et comparer deux runs à
6 mois d'écart ne veut pas dire re-parser du texte aligné. **Pas de HTML** : `renderReport` est déjà
la vue riche de ccsnoop, et le banc assert sur le modèle.

```
bench/runs/<horodatage>/          # extrait depuis $TMPDIR au teardown
  manifest.json                   # snapshot du manifeste utilisé
  provenance.json                 # version CC, version ccsnoop, port, horodatage, comptes calibrés
  arm-00/capture/…                # session-dir extrait
  arm-00/arm.json                 # modèle lu par loadSession + méta du bras
  …
  arm-07/…
  diff.json                       # écrit par `diff`
```

⚠ **`bench/runs/` est dans l'arbre git et rien ne l'ignore** — `init` gitignore `.ccsnoop/`, pas
`bench/runs/`. Le run vit sous `$TMPDIR` (§2) ; `bench/runs/<horodatage>/` n'existe que pour un run
qu'on **garde délibérément**. Ajouter `bench/runs/` au `.gitignore` du repo à l'impl, sinon un
`git add -A` committe des blobs de capture. C'est aussi le seam sur lequel atterrira le brouillard
« redaction des artefacts archivés » de #46 — le nommer ici garde ce patch honnêtement
post-destination au lieu de le rendre bloquant en douce.

### Schéma de `diff.json` — définition unique

```jsonc
{
  "schemaVersion": 1,
  "run": "<horodatage>",
  "witness": "arm-00",

  "provenance": {                      // obligatoire — B4/B2 : un run sans version CC n'est pas comparable
    "claudeCodeVersion": "2.1.220",
    "ccsnoopVersion": "0.1.0",
    "model": "claude-haiku-4-5-20251001",
    "toolSearch": true,                // régime ENABLE_TOOL_SEARCH, pinné aux 7 bras
    "port": 41377,
    "timestamp": "2026-07-25T10:00:00Z",
    "fixtureCounts": { "mcpTools": 64, "seedAgents": 8 },   // déclarés par la fixture
    "listingSizes": { "deferredToolsBytes": 546, "skillsBytes": 8319, "agentTypesBytes": 2345 }
                                       // rendus par CC — provenance, PAS assertion (B7)
  },

  "degraded": [                        // liste d'axes indisponibles ; ABSENCE ≠ axe présent
    { "axis": "cache", "reason": "usage null — blob de réponse illisible" }
  ],

  "arms": [
    {
      "id": "arm-00",
      "label": "témoin",
      "lever": null,                   // null pour le témoin, "L1".."L6", "all"
      "knob": "hooks.SessionStart (déclaration)",
      "seed": "loaded",
      "sessionId": "645c6781-…",

      // ── OCTETS (source: segments / anatomy) ────────────────────────────────
      "turn1": {
        "anatomy": { "system": 28256, "tools": 57522, "history": 0, "currentTurn": 22919, "total": 108697 },
        "requestBytes": 111056,        // toujours les DEUX (anatomy.total < requestBytes)
        "segments": [
          { "slot": "tool:Workflow", "bucket": "tools", "bytes": 21525 }
          // … un par slot ; aucun champ token ici, jamais
        ]
      },
      "turn2": {
        "anatomy": { "…": 0 },
        "requestBytes": 111224,
        "segments": []
      },

      // ── TOKENS (source: usage UNIQUEMENT ; par bras, jamais par slot) ──────
      "usage": {
        "turn1": { "inputTokens": 10, "cacheRead": 0,     "cacheCreation": 29367, "outputTokens": 103 },
        "turn2": { "inputTokens": 8,  "cacheRead": 29367, "cacheCreation": 142,   "outputTokens": 51 }
      },
                                       // omis (pas mis à zéro) si l'axe cache est dégradé

      // ── CONTEXTE, hors verdict ─────────────────────────────────────────────
      "context": { "durationMs": 8412, "waste": { "bloatCount": 3, "flagship": "tool:Workflow" } }
    }
  ],

  // ── VERDICT : un objet par bras levier, delta net vs témoin ───────────────
  "levers": [
    {
      "id": "arm-01",
      "lever": "L1",
      "label": "L1 tools deny",
      "declaredCount": null,           // renseigné pour L6 (8 agents) — imprimé à côté du delta
      "deltaBytes": {                  // net vs témoin, par bucket, sur le tour où le bucket est défini
        "readOn": "turn1",
        "system": 3, "tools": -35919, "history": 0, "currentTurn": 0,
        "anatomyTotal": -35916, "requestBytes": -35916
      },
      "substitutions": [               // slots présents dans le bras, absents du témoin (B3/B6)
        { "slot": "tool:Glob", "bytes": 981 },
        { "slot": "tool:Grep", "bytes": 3640 }
      ],
      "steadyStateTokens": {           // tour 2 seulement — le verdict cache
        "cacheRead": 14592, "inputTokens": 8
      },
      "transitionCostTokens": {        // tour 1 — ligne À PART, jamais soustraite du gain
        "cacheCreation": 14592
      },
      "sentinel": { "name": "slot-set-diff", "presentInWitness": true, "absentInArm": true }
    }
  ],

  // ── Lignes globales au run ─────────────────────────────────────────────────
  "interaction": {                     // Σ(bras) − all : les deltas ne sont PAS additifs (B3/B6)
    "readOn": "turn1",
    "sumOfLeversBytes": -71000,
    "allArmBytes": -68000,
    "interactionBytes": -3000,
    "interactionTokens": -800          // uniquement si l'axe cache est disponible
  },

  "notes": [                           // lectures obligatoires, rendues dans la table (§3)
    "L6 est dimensionné en compte (8 agents), pas en octets.",
    "Les agent-types bundled sont un plancher constant : le delta L6 ne mesure que les agents ajoutés.",
    "8 192 o d'entrée ne donnent pas des lignes de base égales sur le fil (encadrements d'injection)."
  ]
}
```

### Table terminale

Dérivée du **même objet**, jamais recalculée. Contraintes :

- **Bandeau de dégradation en tête, pas une note en pied**, si `degraded` est non vide.
- **Les deux totaux imprimés** (`anatomyTotal` et `requestBytes`), avec l'écart visible.
- **Le compte déclaré imprimé à côté du delta** pour L6 (seul levier dimensionné en compte depuis #78).
- Une ligne par levier ; sous chaque levier, ses **substitutions**.
- Deux lignes globales : **interaction** et, par bras, **coût de transition**.
- Les trois `notes` rendues.

---

## 7. Réconciliations faites en assemblant

Quatre points où l'assemblage a fait tomber une contradiction ou une donnée périmée.

1. **[#53](https://github.com/ledahu05/ccsnoop/issues/53) et
   [#54](https://github.com/ledahu05/ccsnoop/issues/54) sont fermés** — les Notes de la carte les
   donnent vivants. `readUsage` gunzippe désormais (`src/report.js:126`, avec repli sur les octets
   bruts si le gzip est tronqué), et `report --all` honore `CCSNOOP_HOME`
   (`src/report.js:400` → `defaultHome()`). Conséquences : **l'axe cache est mesurable dès le premier
   run**, `degraded` devient un repli rare et non le régime attendu, et le verdict `cacheRead` du
   tour 2 est live. La garde « gzip observé » reste **sur les octets bruts** (`1f 8b`), pas sur
   `usage != null` — sinon le repli truncated-gzip de #53 la rendrait fausse. La consigne de B1
   « `--root`, jamais `--all` » **tient quand même** : plus étroit, et `report` n'accepte pas
   `--home` (seule la variable d'env `CCSNOOP_HOME` est lue).
2. **`init` et le daemon sont run-scoped, pas per-bras.** B5 décrit la séquence nominale
   `start → init → claude -p → status → stop → report` et B4 découpe en `arm <id>`. Le cwd étant
   **partagé** par les 7 bras (B4) il n'y a qu'**une** route, donc un `init`. `arm <id>` est
   idempotent sur les étapes 1–7 ; `stop` et `init --undo` vivent dans `teardown`.
3. **`git init` dans le cwd matérialisé est compatible avec « hors de tout repo git ».** B1 le veut
   pour exercer la branche gitignore de `init` ; B7 l'interdit *dans* le repo ccsnoop. Résolu : le
   cwd est sous `$TMPDIR` et devient son **propre** top-level git — la défense de B7 est
   « aucun **ancêtre** ne porte `CLAUDE.md`/`.claude/` », que `$TMPDIR` satisfait.
4. **`report` est exercé pour la couverture E2E ; le verdict porte sur `loadSession()`.** B5 veut
   `report` dans le chemin nominal, B3 interdit de scraper le HTML. Les deux : étape 16 lance la CLI
   et jette le HTML, étape 17 lit le modèle en process.
5. **`FIXED.txt` ajouté à la fixture.** Le récapitulatif livrable de B7 ne le liste pas, alors que le
   prompt canonique de B2 (« Read the file FIXED.txt and reply with only its first word ») en dépend :
   forcer **exactement un `Read`** d'un fichier au contenu fixe est ce qui donne un `tool_result`
   déterministe (196 o, identique entre runs) et un 2ᵉ POST — donc l'axe cache auto-causé. Sans outil,
   1 seul POST et aucun verdict cache. Le fichier est **partagé** comme le reste du cwd, donc sans
   biais entre bras.

---

## 8. Budget du run

**7 bras × 2 tours = 14 requêtes réelles** (B3), un seul run par bras (B2).

Estimation de **planification** — dérivée du `usage` réellement capturé en B2 (29 367 tokens de
préfixe pour une requête #1 de 111 ko, + ~20 ko ajoutés par la fixture ⇒ ~30–35 k tokens de préfixe
par bras). Ce n'est **pas** un ratio octets↔tokens et ça n'entre pas dans `diff.json` : la règle
d'unité de §4 interdit toute conversion affichée.

Tarifs Claude Haiku 4.5 : entrée $1,00 / MTok · sortie $5,00 / MTok · écriture de cache 5 min
$1,25 / MTok · lecture de cache $0,10 / MTok.

| poste | volume par bras | coût par bras |
|---|---|---|
| tour 1 — `cacheCreation` (préfixe inédit, chaque bras a le sien) | ~30–35 k tok @ $1,25 | ~$0,044 |
| tour 2 — `cacheRead` (régime stationnaire) | ~30–35 k tok @ $0,10 | ~$0,0035 |
| tour 2 — `cacheCreation` résiduel | ~150 tok @ $1,25 | ~$0,0002 |
| sorties (2 tours) | ~200 tok @ $5,00 | ~$0,001 |
| **total** | | **≈ $0,05** |

**Coût d'un run complet des 7 bras : ≈ $0,35.** `diff <run>` est à coût zéro (relit le disque).
Rejouer un seul bras coûte ~$0,05 — c'est ce qui justifie le découpage de B4.

Deux nuances : chaque bras porte un préfixe **différent** (settings différents), donc chacun paie sa
propre écriture de cache — on ne peut pas amortir entre bras. Et rejouer le **même** bras dans le TTL
de cache donne un tour 1 **chaud** (B2), ce qui change son `usage` : c'est une variable de protocole,
pas une économie à rechercher.

---

## 9. Non-objectifs — nommés, pas passés sous silence

**Le banc ne fait pas ça, et ce n'est pas un oubli.**

| Non-objectif | Pourquoi |
|---|---|
| **Seuils de gain / assertions sur le chiffre** | Un gain est un delta net imprévisible (B6) ; un seuil codé aujourd'hui casse au prochain build CC. `exit ≠ 0` sur l'intégrité seule (§5). |
| **Intégration CI** | Le banc exige des creds, dépense de vrais tokens et écrit des config-dirs jetables. Reste du brouillard sur la carte #46. |
| **Référence versionnée d'un run** | Ce qu'on garde quand un run devient une référence, et sous quelle inspection (redaction des artefacts archivés) reste du brouillard sur #46. Aujourd'hui les runs sont locaux ; ccsnoop redacte déjà `Authorization`. |
| **La moitié « connectors claude.ai » de L4** | Non reproductible sans le compte du dev, et `ANTHROPIC_API_KEY` la rend justement non mesurable (B1). `disableClaudeAiConnectors` abandonné : poids mort sous isolation (B7). |
| **L'autre moitié de L4 — les serveurs `.mcp.json`** | `claude -p` POSTe avant la fin du handshake MCP : les outils du stub n'atteignent le fil qu'au **tour 3**, hors de portée du diff de requête #1 (`turns: 2`). Mesurable seulement en allongeant le prompt canonique, ce qui imposerait de re-baseliner tous les octets de §3/§4. Écarté sur [#78](https://github.com/ledahu05/ccsnoop/issues/78) ; le levier reste **produit** (`fine-tune`, #74), il n'est plus **pesé** par le banc. Le stub reste déclaré et gardé connecté (étape 11b) : c'est du régime, pas un levier. |
| **L'économie absolue sur omniris** | Non reproductible par construction. Le banc prouve mécanisme et ordre de grandeur (B4). |
| **Sous-segmenter `message#0`** | Ni dans le banc (contrat CC non documenté) ni dans `src/waste.js` (modifie le produit sous test). L'attribution est structurelle : un bras par levier (B3). |
| **Décider ce qui compte comme waste, ou pricer un cache write** | Appartient à [#29](https://github.com/ledahu05/ccsnoop/issues/29) et [#36](https://github.com/ledahu05/ccsnoop/issues/36). Le banc mesure et compare, il ne redéfinit pas (B3). |
| **Construire la sous-commande `fine-tune`** | Autre carte. Quand elle existera, elle sera **un bras de plus**, pas une dépendance (B3). |
| **Suite de régression CI hermétique sur fixtures** | Écartée au moment de nommer la destination, au profit du banc live. Reviendrait comme effort distinct. |
| **Rejouer le hors-nominal** | Les 8 cas hors-chemin *et* les 4 comportements sous-jacents sont **déjà unit-testés** ; les re-jouer live paie une session API pour re-prouver du gratuit. Liste nommée ci-dessous (B5). |
| **Assertion sur `init --undo`** | Dans le banc en **hygiène de teardown** seulement. La restauration exacte est couverte par `test/init.test.js` (B5). |
| **Paralléliser les bras** | Bloqué par la question ouverte de B1 (refresh OAuth sous creds recopiés). Séquentiel jusqu'à décision. |
| **`claude setup-token`** | La vraie réponse unattended, délibérément non exercée en B1 (risque d'écriture dans la config réelle). |

**Explicitement laissé aux tests unitaires** (à nommer pour qu'un futur lecteur ne prenne pas
l'absence pour un oubli) : `init --undo` restauration exacte · `init --force` base URL étrangère ·
`--all` + routes multi-repo · `report --session <id>` · port occupé (`EADDRINUSE`) · seuils
`--bloat-floor` / `--bloat-multiplier` · daemon déjà démarré · `stop` sans daemon · préflight sur
token inconnu · réassemblage SSE hors ligne · redaction des headers · chute de connexion des deux
côtés.

---

## 10. Prérequis d'implémentation

1. **`src/report.js` gunzippe** — acquis, #53 fermé.
2. **Fixture à construire et calibrer une fois** : générer `CLAUDE.md` et `hook-persona.txt` à
   8 192 o exactement (chacun porteur de sa sentinelle), `mcp-stub.mjs` à 64 outils, `seeds/loaded/agents/`
   à 8 agents. Puis un run de calibration, comptes gelés, tailles de listing enregistrées en
   provenance.
3. **Cibles de `arm-01` choisies dans le `tools[]` observé du témoin**, pas dans une liste écrite
   à l'avance (B6).
4. **Ordre de vérification à l'impl** : `claudeMdExcludes` existe au schéma v2.1.220 mais son
   application **reste à constater sur le fil** (B7). La garde §4.1 est ce qui empêche un knob
   inopérant de passer pour « levier nul » — elle doit être en place avant le premier run payant.
