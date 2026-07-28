# Le levier 1 mesuré sur le fil — `permissions.deny` et `tools[]`

Ticket : [issue #52](https://github.com/ledahu05/ccsnoop/issues/52) — *« un **nom d'outil nu** dans
`permissions.deny` retire-t-il bien le schéma de `tools[]` de la requête ? »* — partie de la map
[#46](https://github.com/ledahu05/ccsnoop/issues/46).

**Verdict court : OUI, le mécanisme est réel, et il retire vraiment les octets du fil — mais il est
partiellement remboursé.** Un bras `deny` de 5 noms nus fait passer le bucket `tools` de
**57 522 → 21 603 octets** (−62,5 %) et la requête #1 entière de **93 876 → 57 960 octets**
(−35 916 o, −38,3 %), soit **−9 759 tokens de préfixe** (24 351 → 14 592, `usage` capturé). Le
résidu est **nul** : aucun nom dénié ne subsiste dans `system[]`, dans un `<system-reminder>`, ni
dans le listing des outils différés (byte-identique entre les deux bras).

**Deux remboursements, mesurés, à porter dans la règle d'attribution :**

1. **Dénier `Bash` fait apparaître `Glob` (981 o) et `Grep` (3 640 o)** — ils n'étaient dans
   *aucun* des deux inventaires avant. Le gain net de `Bash` n'est pas 11 694 o mais
   **7 073 o (−60 %)**. **Isolé** par une cellule dédiée : `deny: ["Bash"]` seul ⇒ 25 → 26 outils,
   `−Bash +Glob +Grep`. Ce n'est pas une inférence tirée du bras à 5 noms.
2. **Le prompt du harness (`system#2`) n'est pas le même prompt d'un bras à l'autre** : CC sert une
   **variante**, avec une churn à double sens qui *nette* à +3 o mais bouge 45 o de contenu —
   ligne 43 **+24 o** (« *Prefer dedicated tools over **Bash** … (Read, Edit, Write)* » →
   « *over **PowerShell** … (Read, Edit, Write, Glob, Grep)* ») et ligne 70 **−18 o**
   (« *use `find` or `grep` via the Bash tool* » → « *use the Glob or Grep directly* »). Le plancher
   `system` n'est donc **pas invariant entre bras** — et un delta net proche de zéro y masque un
   changement de prompt réel.

Toutes les tailles sont des **OCTETS** (`Segment.bytes` / `Anatomy.*`, parseur du repo). Les
**tokens** viennent uniquement du `usage` capturé. Aucune re-tokenisation.

**Environnement mesuré : CC `2.1.220`** (`User-Agent: claude-cli/2.1.220 (external, sdk-cli)`),
linux-x64, auth `claude.ai`, modèle `claude-haiku-4-5-20251001`, `-p`,
`--permission-mode bypassPermissions`, `ENABLE_TOOL_SEARCH=true` (écrit par `ccsnoop init`).

Harnais : [`probes/bench-deny-mechanism-probe.mjs`](./probes/bench-deny-mechanism-probe.mjs) —
importe `segmentRequest` de `src/waste.js`, `loadSession` / `computeAnatomy` de `src/report.js`.
Pas de second parseur.

---

## Protocole

Deux bras **live**, ne différant **que** par `<arm>/.claude/settings.json`, canal d'injection
`CLAUDE_CONFIG_DIR` (B1, [#47](https://github.com/ledahu05/ccsnoop/issues/47)), creds recopiés en
0600 puis supprimés, lancés **séquentiellement**, même cwd, même prompt canonique de B2
(`Read the file FIXED.txt and reply with only its first word.`), un seul run par bras
(plancher de bruit = 0 o, B2 [#48](https://github.com/ledahu05/ccsnoop/issues/48)).

| Bras | `settings.json` |
|---|---|
| **control** | `{}` |
| **deny** | `{"permissions":{"deny":["Workflow","ScheduleWakeup","ReportFindings","ShareOnboardingGuide","Bash","Read(/etc/ccsnoop-nonexistent/**)"]}}` |

Cibles choisies dans la capture haiku réelle de B2 — donc **des outils dont on savait déjà qu'ils
expédient un schéma sur le fil** sous `ENABLE_TOOL_SEARCH`. `Bash` sert aussi de test « outil cœur
du harness » (Q4), et `Read(/etc/…)` d'entrée **scopée** (Q3) : `Read` doit survivre.

En amont, **5 cellules `system/init` à zéro token** (port mort → CC émet `system/init` avant de
POSTer), pour le scope, les outils inertes et le pré-vol des settings.

⚠ **Ceiling de l'instrument `system/init`**, à ne pas oublier : la liste d'outils de `system/init`
n'est **pas** `tools[]`. Le pré-vol du bras contrôle **live** annonce **30 outils connus** ; sur le
fil ce sont **12 entrées de `tools[]`** — 11 schémas réels + le synthétique
`DeferredToolPlaceholder` — **plus** un listing différé de 546 o à 19 noms (11 + 19 = 30, l'égalité
tombe juste). `system/init` répond « l'outil est-il encore **connu** » (suffisant pour Q3/Q4) ; seul
le fil répond « des octets ont-ils été **économisés** » (Q1/Q2).

⚠ **Ne pas comparer un compte de cellule zéro-token à un compte de bras live** : les cellules du
sweep tournent **sans creds** (25 outils) alors qu'un bras live en a (30). D'où deux nets
différents pour le *même* `deny` — sweep 25 → 23 (−2 net), pré-vol live 30 → 27 (−3 net) : sans
creds, `ShareOnboardingGuide` n'existe pas, donc le dénier est un no-op. Le mécanisme est stable ;
c'est l'inventaire qui change de taille selon l'auth (déjà vu en B1 avec `ANTHROPIC_API_KEY`).

---

## 1. Retrait effectif — ✅ oui, schéma supprimé, pas juste dénié au call-time

Diff par slot `tool:<name>` (`segmentRequest`), requête #1 de chaque bras :

| Slot | control | deny | |
|---|---:|---:|---|
| `Workflow` | **21 525** | 0 | RETIRÉ |
| `Bash` | **11 694** | 0 | RETIRÉ |
| `ScheduleWakeup` | **3 838** | 0 | RETIRÉ |
| `ReportFindings` | **2 181** | 0 | RETIRÉ |
| `ShareOnboardingGuide` | **1 299** | 0 | RETIRÉ |
| `Glob` | 0 | **981** | **AJOUTÉ** |
| `Grep` | 0 | **3 640** | **AJOUTÉ** |
| `Read` | 2 588 | 2 588 | inchangé (scope, cf. §3) |
| `Agent` `Edit` `Skill` `ToolSearch` `Write` `DeferredToolPlaceholder` | — | — | inchangés à l'octet |

| Bucket | control | deny | Δ |
|---|---:|---:|---:|
| `tools` (`computeAnatomy`) | 57 522 | 21 603 | **−35 919** |
| `system` | 28 256 | 28 259 | **+3 net** (45 o de contenu bougés, cf. remboursement n°2) |
| `messages` (`message#0`) | 8 098 | 8 098 | **0** (byte-identique) |
| **total requête #1** | **93 876** | **57 960** | **−35 916 (−38,3 %)** |
| nb de schémas | 12 | 9 | −3 |

Somme brute des schémas retirés : **40 537 o**. Remboursement `Glob`+`Grep`+`system` :
**4 621 + 3 = 4 624 o**. **Net : −35 916 o.**

Côté `usage` capturé (tokens, requête #1 = premier POST portant `tools[]`) :

| Bras | `cache_creation` | `cache_read` | préfixe total |
|---|---:|---:|---:|
| control | 2 467 | 21 884 | **24 351 tok** |
| deny | 2 467 | 12 125 | **14 592 tok** |

**Δ = −9 759 tokens (−40,1 %)**, cohérent avec les octets : 35 916 / 9 759 = **3,68 o/tok**, dans
la fourchette haiku de B2 (3,78). *(Le split creation/read entre bras n'est pas interprétable ici :
le bras `control` a tourné en premier et a écrit le préfixe — cf. B2 §2. Seule la somme compte.)*

Ordre de grandeur revendiqué par `omniris_tuning.md` pour le levier 1 : ~11 K tokens. Mesuré ici
avec 5 outils déniés : **9 759 tokens**. Le levier est **réel et du bon ordre** ; il n'est pas
« confirmé par la doc » — il est confirmé sur le fil.

## 2. Résidu ailleurs — ✅ aucun, hors mentions en prose

Recherche des noms déniés dans **tous** les slots de la requête du bras `deny` :

| Nom dénié | occurrences | slots |
|---|---:|---|
| `Workflow` | **0** | — |
| `ScheduleWakeup` | **0** | — |
| `ReportFindings` | **0** | — |
| `ShareOnboardingGuide` | **0** | — |
| `Bash` | 3 | `tool:Agent`, `tool:Grep`, `message#0` |

- **Pas de glissement vers la liste des outils différés** (crainte de
  [#31](https://github.com/ledahu05/ccsnoop/issues/31)) : le listing différé est **byte-identique
  entre les deux bras — 546 o, mêmes 19 noms** (`CronCreate … WebSearch`). Un outil dénié
  **disparaît**, il n'est pas rétrogradé en nom différé.
- **Pas de résidu dans `system[2]`** ni dans un `<system-reminder>` : `message#0` est
  byte-identique (8 098 o) entre les bras.
- Les 3 occurrences de `Bash` sont des **mentions en prose** dans la description d'autres outils
  (`Agent`, `Grep`) et dans le listing des skills — quelques dizaines d'octets, pas un schéma. CC
  ne réécrit pas la prose ; à traiter comme du plancher, pas comme un retrait raté.
- **Arithmétique du différé** : 546 o pour 19 noms ≈ **29 o par nom**. Dénier un outil **déjà
  différé** (`WebFetch`, `NotebookEdit`, `SendMessage`…) ne rend donc que ~29 o — 0,13 % de ce que
  rend `Workflow`. *Le gain d'un deny n'est pas fonction du nombre d'outils déniés, mais de la
  taille des schémas effectivement présents dans `tools[]`.*

## 3. Portée — ✅ le deny scopé ne retire rien, mais `Tool(*)` compte comme nu

Sur le fil : `Read(/etc/ccsnoop-nonexistent/**)` dans `deny` ⇒ `tool:Read` **inchangé à l'octet**
(2 588 o dans les deux bras). L'affirmation de
[#30](https://github.com/ledahu05/ccsnoop/issues/30) est **vérifiée**, plus héritée.

Cellule `system/init` « scoped-only » (zéro token), `deny: ["Bash(rm:*)", "Read(/etc/**)", "Workflow(*)"]` :

| entrée | effet sur la liste d'outils |
|---|---|
| `Bash(rm:*)` | **aucun** |
| `Read(/etc/**)` | **aucun** |
| `Workflow(*)` | **retire `Workflow`** ⚠ |

⚠ **`Tool(*)` se comporte comme un nom nu.** Un banc qui classe les entrées de `deny` en
« nu vs scopé » sur la présence d'une parenthèse se trompera : le discriminant est le **contenu**
du scope, pas la parenthèse. Règle mesurée : scope vide/`*` ⇒ retrait ; scope non trivial ⇒ rien.

## 4. Outils non-retirables — aucun trouvé, y compris les outils cœur

Cellule `iso-deny-core` (zéro token), `deny` = 14 noms nus dont `Read`, `Edit`, `Write`, `Bash`,
`Task`, `Skill`, `ToolSearch`, `WebFetch`, `WebSearch`, `NotebookEdit` :
**25 → 16 outils**, retirés : `Bash`, `Edit`, `NotebookEdit`, `Read`, `Skill`, `Task`, `WebFetch`,
`WebSearch`, `Write`. **Rien d'inerte** — même `Read` et `Edit` partent. (`Glob`, `Grep`, `Agent`,
`ToolSearch` étaient absents de l'inventaire `system/init` de la cellule contrôle, donc « non
retirés » par absence, pas par immunité ; sur le fil, `Bash` a bien été retiré et `ToolSearch`
n'était pas dénié.)

**Le banc n'annonce donc pas un gain sur un levier inerte.** Le piège n'est pas l'immunité, c'est
la **substitution** : retirer `Bash` en fait revenir deux autres (§1). Une déclaration de bras doit
mesurer le **delta net du bucket**, jamais la somme des schémas visés.

## 5. Version et fragilité

- **CC `2.1.220`**, `sdk-cli`, linux-x64. Inventaire fil du bras contrôle (12 schémas, 57 522 o) :
  `Workflow` 21 525 · `Bash` 11 694 · `Agent` 8 193 · `ScheduleWakeup` 3 838 · `Read` 2 588 ·
  `ReportFindings` 2 181 · `Skill` 1 811 · `Edit` 1 702 · `ToolSearch` 1 450 ·
  `ShareOnboardingGuide` 1 299 · `Write` 1 024 · `DeferredToolPlaceholder` 204.
- **`Workflow` seul pèse 37 % du bucket `tools`** et 23 % de la requête #1. Un levier 1 « utile »
  est en pratique *un* nom bien choisi ; la liste de 5 de `omniris_tuning.md` est surtout
  décorative après `Workflow`.
- Ce qui peut bouger d'une version à l'autre, et qu'un banc doit re-mesurer plutôt que citer :
  la **taille** de chaque schéma, la **substitution `Bash`→`Glob`/`Grep`**, la sensibilité de
  `system#2` au jeu d'outils, et la partition schémas/différés (dépend de `ENABLE_TOOL_SEARCH`,
  que `ccsnoop init` impose).

---

## Constats de méthode ramenés à la map

- **⚠ Le nom du config-dir du bras fuit dans `system#2`** : ligne 75, « *persistent, file-based
  memory system at `/tmp/ccsnoop-b6/arm-**control**/.claude/projects/…`* » vs `arm-**deny**` — un
  faux Δ de **−3 o** rien qu'à cause de la longueur du chemin. **Contrainte de banc : les
  répertoires de bras doivent avoir des noms de même longueur** (`arm-a` / `arm-b`, ou un hash de
  taille fixe), sinon chaque bras porte un biais silencieux dans le bucket `system`. Ici les 3 o
  s'annulent presque avec les +6 o de churn d'outillage pour donner le +3 o net observé.
- **`--permission-mode bypassPermissions` ne neutralise pas `deny`** : cellules `iso-deny` et
  `iso-deny+bypass` retirent exactement les mêmes 4 outils. Le prompt canonique de B2 (qui exige
  `bypassPermissions`) est donc compatible avec le levier 1.
- **Le piège « settings malformé silencieusement ignoré » existe aussi via `CLAUDE_CONFIG_DIR`** :
  cellule `iso-malformed` ⇒ 25 outils, **indiscernable du contrôle**, exit 0, rien sur stderr. Le
  pré-vol `system/init` **sur le répertoire même que le run live utilisera** est obligatoire (c'est
  ce que fait la probe avant chaque bras) — et il vaut mieux que `claude doctor`, puisqu'il compte
  les outils réellement chargés.
- **Le port du banc n'est pas négociable** : le démon du dev tient le port par défaut, donc
  `ccsnoop start` du banc échoue (`port busy`, exit 1) — et `init` écrit dans
  `settings.local.json` l'URL du port *configuré*, pas du port *écoutant*. Séquence qui marche :
  `start --port <libre>` (persiste dans `<home>/config.json`) → `stop` → `init` → `start --port
  <libre>` → **attendre la socket** (`start` est détaché et rend la main avant le `listen` : un
  premier essai a donné `ECONNREFUSED`). Sans cette danse, la session part sur un 502 et le bras
  est perdu.
- **Un garde-fou d'accessibilité avant de dépenser des tokens** vaut son coût : le premier essai a
  bien renvoyé un `HTTP 502` (route inconnue du démon du dev, home divergent) et les deux
  invocations `claude -p` ont échoué à 0 token. La probe refuse maintenant de lancer un bras si un
  enfant **spawné** n'obtient pas 200 sur `<baseUrl>/api/hello`.
- **Contredit une limite de B1** : le loopback TCP **n'était pas bloqué** dans ce sous-agent — un
  enfant spawné a bien atteint le démon local et deux vraies sessions `claude -p` ont été capturées
  depuis un sous-agent CC. La contrainte « le driver du banc ne peut pas être un sous-agent »
  n'est donc **pas universelle** ; elle dépend de la configuration du sandbox. Un banc AFK doit
  quand même porter le garde-fou d'accessibilité, qui rend la panne bruyante au lieu de silencieuse.
- **Question ouverte de B1, un point de donnée** : deux bras séquentiels avec `.credentials.json`
  recopié n'ont **pas** invalidé les creds du dev (`claude auth status` → `loggedIn: true` après).
  Un point, pas une garantie ; ne pas paralléliser pour autant.

## Ce que ça change pour #46 / #29 / #49 / #50

Le mécanisme **tient** — mais pas sous la forme « somme des schémas déniés » :

1. **Règle d'attribution ([B3 #49](https://github.com/ledahu05/ccsnoop/issues/49))** : le gain du
   levier 1 est un **delta net du bucket `tools`**, jamais une somme de slots retirés. Deux effets
   de bord mesurés l'exigent (substitution `Glob`/`Grep`, `system#2` sensible au jeu d'outils).
2. **Déclaration des bras ([B4 #50](https://github.com/ledahu05/ccsnoop/issues/50))** : dénier un
   outil **déjà différé** rend ~29 o. Un bras doit donc nommer ses cibles à partir du `tools[]`
   **observé** dans le bras contrôle, pas d'une liste écrite à l'avance ; sinon il publie un
   « levier 1 » qui ne bouge rien.
3. **Détection statique ([#29](https://github.com/ledahu05/ccsnoop/issues/29))** : une future
   `fine-tune` peut proposer des noms nus en toute confiance (le retrait est réel), à condition de
   trier par **octets de schéma mesurés** — `Workflow` (21,5 ko) vaut 20 × `Write` (1 ko) — et de
   signaler que dénier `Bash` en rembourse 40 %.
4. `omniris_tuning.md` peut passer le levier 1 de « mécanisme confirmé *(doc)* » à
   « **mesuré sur le fil, CC 2.1.220 : −35 916 o / −9 759 tok pour 5 noms** », avec la réserve de
   substitution.

## Reproduire

```bash
# 1. cellules system/init — zéro token
node docs/research/probes/bench-deny-mechanism-probe.mjs sweep

# 2. deux runs live à travers ccsnoop (~0,02 $ au total, haiku)
node docs/research/probes/bench-deny-mechanism-probe.mjs capture 41999

# 3. diff par outil, parseur du repo
node docs/research/probes/bench-deny-mechanism-probe.mjs analyze \
  /tmp/ccsnoop-b6/repo/.ccsnoop/sessions/<control-id> \
  /tmp/ccsnoop-b6/repo/.ccsnoop/sessions/<deny-id>

# 4. démon arrêté, route retirée, copies de creds supprimées
node docs/research/probes/bench-deny-mechanism-probe.mjs clean
```

Nettoyage effectué : démon du banc arrêté, route `8c3bdc18` retirée du `routes.json` **du banc**
(`CCSNOOP_HOME=/tmp/ccsnoop-b6/ccsnoop-home`), les deux copies de `.credentials.json` supprimées
(`find` sans résultat), `~/.ccsnoop/routes.json` et le démon du dev (pid 3713877, port 41377)
inchangés, `~/.claude/` jamais écrit. Les captures restent sous `/tmp/ccsnoop-b6` — ccsnoop
**rédige déjà l'en-tête `Authorization`** (`‹REDACTED›` dans les `.request.http`), donc elles ne
portent pas de secret ; `rm -rf /tmp/ccsnoop-b6` quand elles n'ont plus d'usage.
