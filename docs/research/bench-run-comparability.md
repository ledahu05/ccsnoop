# Comparabilité de deux runs `claude -p` — mesures pour le banc de tuning

Ticket : [issue #48](https://github.com/ledahu05/ccsnoop/issues/48) — *« Deux sessions `claude -p`
du même prompt sont-elles comparables, et combien de tours faut-il pour que chaque levier soit
observable ? »* — partie de la map [#46](https://github.com/ledahu05/ccsnoop/issues/46).

**Verdict court : oui, et un run mono-tour suffit pour l'axe bloat.** La requête #1 est
**byte-for-byte identique** entre deux runs du même prompt (plancher de bruit = **0 octet**,
LCP de hash = 100 %), les 4 leviers y sont **tous** présents, et le bruit au tour 2 est de
**168 octets** contre un signal attendu de ~19 K tokens ≈ **72 000 octets** — soit **~430×**
(2,6 ordres de grandeur). **Un run par bras suffit.** Deux **blocages** sont ressortis en
chemin (§6) : les blobs de réponse sont gzippés donc `readUsage()` renvoie `null` sur tout,
et la granularité `Segment` ne sépare pas trois des quatre leviers.

Toutes les tailles ci-dessous sont des **OCTETS** (`Segment.bytes` / `Anatomy.*`). Les
**tokens** viennent uniquement du `usage` capturé. Aucune re-tokenisation.

Harnais : [`probes/bench-run-comparability-probe.mjs`](./probes/bench-run-comparability-probe.mjs)
— importe `loadSession` / `readUsage` / `computeAnatomy` de `src/report.js` et
`segmentRequest` / `computeWaste` de `src/waste.js`. Pas de second parseur.

## Corpus mesuré

| Session | Repo / cwd | Modèle | POSTs | Rôle dans l'étude |
|---|---|---|---|---|
| `309efa6b-aa8d-4577-a46a-7ff43d6a3ef0` | `/home/chris/omniris` | `claude-opus-5` | 4 | session de `omniris_tuning.md` ; axe cache multi-tours |
| `e9b855f8-1979-4f65-8209-85b06759c31c` | `/home/chris/omniris` | `claude-opus-5` | 2 | paire « conditions voisines » (34 min d'écart) |
| `eb47e8fd-772b-4c9d-91a3-4cbad1fbba7c` | `/home/chris/omniris` | — | 1 | sonde quota seule, **aucun** `tools[]` |
| `645c6781-6067-4ee7-947f-9c6d317ed2a1` | `/tmp/ccsnoop-b2` | `claude-haiku-4-5-20251001` | 2 | **run A** — paire même-prompt (neuf) |
| `db1db459-b039-47b1-ad73-aa7adf6f2338` | `/tmp/ccsnoop-b2` | `claude-haiku-4-5-20251001` | 2 | **run B** — paire même-prompt (neuf) |

CC `2.1.220` (`cc_version=2.1.220.927; cc_entrypoint=sdk-cli` sur la paire neuve).
Les deux runs neufs : même cwd, même prompt, à la suite, rien modifié entre les deux.
Prompt : `Read the file FIXED.txt and reply with only its first word.`

⚠ **« Requête #1 » = le premier POST portant un `tools[]` non vide**, pas le premier
exchange du manifest. Dans les captures omniris, l'exchange `turn:1` est une **sonde quota**
(`{"model":…,"max_tokens":1,"messages":[{"role":"user","content":"quota"}]}`, 33 octets de
corps utile, aucune réponse `usage`). Le banc doit la filtrer : sinon elle devient la baseline
de lignée du vrai tour 1 et écrase le `cacheBoundary` à 0 (observé : `boundary=0` au tour 2 de
`309efa6b` malgré `cache_read=21 394`). La session `eb47e8fd` ne contient **que** cette sonde.

---

## 1. Visibilité en requête #1 — les 4 leviers y sont TOUS

Ventilation par **bloc de texte** du premier POST de `645c6781` (111 056 octets au total) :

| Bloc | octets | % req | Levier |
|---|---|---|---|
| `tools[]` — 13 définitions | **57 577** | 51,8 % | **L1** |
| `system#2` (prompt harness) | 30 308 | 27,3 % | ❌ plancher |
| `msg#0/block4` — listing des **skills** | 8 319 | 7,5 % | *(non listé dans `omniris_tuning.md`)* |
| `msg#0/block1` — hook SessionStart PONYTAIL | 5 536 | 5,0 % | **L2** |
| `msg#0/block5` — `<system-reminder>` `# claudeMd` | 3 503 | 3,2 % | **L3** |
| `msg#0/block3` — listing des **agent types** | 2 345 | 2,1 % | *(non listé)* |
| `msg#0/block0` — hook SessionStart CAVEMAN | 2 012 | 1,8 % | **L2** |
| `msg#0/block2` — **listing d'outils différés / MCP** | 1 038 | 0,9 % | **L4** |
| `system#1` + `system#0` (billing header) | 234 | 0,2 % | ❌ plancher |
| **prompt utilisateur réel** | **132** | **0,12 %** | — |

- **L1** = 13 slots `tool:*` (`Agent, Bash, Edit, Read, ReportFindings, ScheduleWakeup,
  ShareOnboardingGuide, Skill, ToolSearch, Workflow, DeferredToolPlaceholder, Write, advisor`).
  Dans omniris (opus, connecteurs branchés) : 15 slots, **56 804 octets** — `Artifact` et
  `AskUserQuestion` en plus.
- **L2** : deux blocs distincts (un par hook SessionStart), **7 548 octets** cumulés.
  Dans omniris ils arrivent dans un message de rôle **`system`** (beta
  `mid-conversation-system-2026-04-07`), 24 005 octets ; en `-p` ils sont fusionnés comme
  `<system-reminder>` dans le message `user`. **Le conteneur change, le levier reste visible.**
- **L3** : le bloc `# claudeMd` — 3 503 octets ici (temp dir), **23 314 octets** dans omniris
  (global + projet + memory).
- **L4** : présent, 1 038 octets ici ; **~2,6 Ko** dans omniris (83 outils `mcp__gitlab__*`).

**Conclusion Q1 : les quatre leviers sont observables dès la requête #1. Un run mono-tour
suffit pour l'axe bloat.** « Lancer une ou plusieurs discussions » se réduit à : un prompt, un
tour, un POST.

**Deux leviers non nommés par `omniris_tuning.md`** apparaissent dans la même requête et
pèsent plus que L3+L4 réunis : le **listing des skills** (8 319 o) et le **listing des agent
types** (2 345 o). Ils appartiennent au bras « tuné » si on veut couvrir le vrai bloat ; à
arbitrer par [#29](https://github.com/ledahu05/ccsnoop/issues/29), pas ici.

**Confond à documenter** : `ccsnoop init` écrit `ENABLE_TOOL_SEARCH=true` dans
`.claude/settings.local.json` (`src/init.js:224`). C'est ce réglage qui fait exister L4 sous
forme de *listing* de noms (+ l'outil `DeferredToolPlaceholder`) au lieu de schémas MCP
complets dans `tools[]`. **Le banc mesure donc L4 sous le régime imposé par ccsnoop lui-même** ;
un bras « MCP non différés » n'est pas mesurable sans contourner `init`.

---

## 2. Ce qui exige ≥ 2 tours — verdict cache

`usage` du POST #1 et #2, par run (tokens, issus du `usage` capturé) :

| Run | POST | `input` | `cache_read` | `cache_creation` | `output` |
|---|---|---|---|---|---|
| A `645c6781` | #1 | 10 | **0** | **29 367** | 103 |
| A `645c6781` | #2 | 8 | **29 367** | 142 | 51 |
| B `db1db459` | #1 | 10 | **29 367** | **0** | 136 |
| B `db1db459` | #2 | 8 | **29 367** | 175 | 81 |

Lecture, décisive pour le banc :

1. **Le `cache_read` de la requête #1 n'est pas causé par le run** — il est causé par ce qui a
   été écrit *avant*. Run A écrit 29 367 tokens (préfixe inédit) ; run B, **prompt identique
   donc préfixe byte-identique**, les **relit** intégralement et écrit 0. Le cache est partagé
   entre sessions, et même entre runs successifs du banc.
2. **Le tour 2 est le premier dont le `cache_read` est auto-causé** (il relit l'écriture de son
   propre tour 1) : 29 367 dans les deux runs, avec un `cache_creation` marginal (142 / 175
   tokens = le delta conversationnel).
3. Corollaire : **minimum 2 tours par bras** pour un verdict cache exploitable, et **l'ordre des
   bras est une variable du protocole** — le second bras exécuté hérite du cache du premier si
   son préfixe est identique. Comme le tuning *change* le préfixe, les deux bras sont froids
   l'un pour l'autre ; mais **répéter le même bras N fois donne un tour 1 chaud dès le run 2**.
   Le banc doit soit ne lire le cache qu'au tour ≥ 2, soit rapporter `cache_read` du tour 1
   comme « contamination inter-runs » et non comme métrique de bras.

Session multi-tours d'omniris (`309efa6b`, opus) — le tour 4 est l'évènement d'invalidation
documenté dans `omniris_tuning.md` :

| turn | octets sys/tools/hist/cur = total | `usage` in/read/write/out | `cold` | `reusedUncached` | `cacheBoundary` |
|---|---|---|---|---|---|
| 1 | 0/0/0/33 = 33 (sonde quota) | *(aucun)* | — | 0 | 0 |
| 2 | 13 062/56 820/23 378/24 035 = **117 295** | 2 / 21 394 / 24 250 / 103 | non | 0 | **0** ← sonde quota comme baseline |
| 3 | 13 062/56 820/48 083/9 985 = **127 950** | 2 / 45 644 / 4 129 / 122 | non | 0 | 19 |
| 4 | 11 024/56 751/58 809/1 468 = **128 052** | 504 / **0** / **48 579** / 35 | **oui** | **105 039 o** | 0 |

Le tour 4 confirme la mesure de `omniris_tuning.md` : `cache_read=0`,
`cache_creation=48 579`, et côté octets `system` passe de 13 062 → 11 024 et `tools` de
56 820 → 56 751 (retrait de l'outil `advisor` + sa section dans `system#2`). Deux mutations
dans le préfixe ⇒ tout est refacturé en write. **C'est aussi la preuve que 2 tours suffisent
à rendre un changement de préfixe visible dans `usage`.**

---

## 3. Sources de non-déterminisme, avec impact en octets

Mesuré sur les deux paires. « Δoctets » = impact sur les buckets ; « hash » = impact sur la
séquence de hash que `classifySegments` utilise pour son LCP.

| Source | Où | Δ octets | Δ hash | Nature |
|---|---|---|---|---|
| `session_id`, timestamps, ordre des clés JSON | corps | **0** | **non** | cosmétique — `canonicalize()` trie déjà les clés ; en `-p` le `session_id` n'apparaît **pas** dans `system` |
| **ordre de `tools[]`** | `tools` | **0** | **non** | **stable** — ordre identique sur les 4 sessions à `tools[]` (voir §3.1) |
| `tool_use_id` (paire tool_use / tool_result) | `history`, `currentTurn` | **0** | **OUI** | 196 → 196 octets, **hash différent** : cosmétique en octets, **casse le LCP** |
| build CC dans `system#0` (`cc_version=2.1.220.5bd` vs `.a94`) | `system#0` | **0** (95 → 95) | **OUI** | dérive de **version binaire** entre deux lancements ; tue le LCP **au segment 0** |
| `session_id` dans le chemin scratchpad de `system#2` | `system#2` | **0** (12 783 → 12 783) | **OUI** | mode **interactif** seulement (`/tmp/claude-1001/<projet>/<session_id>/scratchpad`) ; **absent en `-p`** — UUID de longueur fixe donc Δ0 octet |
| **état de connexion des serveurs MCP** | `currentTurn`/`history` | **−2 584** | oui | omniris : 83 lignes `mcp__gitlab__*` présentes dans un run, réduites à `gitlab` dans l'autre. **Vraie non-déterminisme run-à-run, et c'est exactement le bucket du levier L4.** |
| édition de `CLAUDE.md` entre les runs | bloc `# claudeMd` | **+2 930** | oui | pas du bruit : contenu réellement modifié (34 min d'écart) |
| réponse du modèle (thinking + `tool_use`) | `history` | **+168** | oui | non-déterminisme irréductible du modèle, tour ≥ 2 |
| préflight `HEAD /<token>/api/hello` | — | **non capturé** | — | aucun exchange `HEAD` dans les 5 sessions ; le seul exchange hors-`tools[]` est la **sonde quota** POST |

### 3.1 Ce qui est cosmétique en octets mais pas pour le cache

Le point le plus tranchant : **trois sources bougent le hash à Δ0 octet.**
`classifySegments` (`src/waste.js:245`) calcule le plus long préfixe commun de hash. Résultat
mesuré sur la paire omniris (deux runs voisins, mêmes buckets `system` et `tools` à l'octet) :

```
cross-run hash LCP: 0/20 segments = 0 o sur 116 927 o (0,0 %)
```

`system#0` diverge (build CC) donc le LCP casse au **segment 0**, alors que les 20 segments
pèsent 116 927 octets dont 56 804 strictement identiques. Sur la paire neuve (même build,
même minute) :

```
cross-run hash LCP: 17/17 segments = 111 038 o sur 111 038 o (100,0 %)
```

**Conséquence pour le banc : ne jamais comparer deux bras par LCP de hash.** Le LCP est un
outil *intra-lignée* (`thread_id`). La comparaison inter-bras doit être **par slot** (et
idéalement par bloc, §6.2) : `slot → bytes`, appariés par nom de slot.

---

## 4. Bruit vs signal — un run par bras suffit

| Mesure | Octets |
|---|---|
| Requête #1, plancher de bruit même-prompt (tous buckets) | **0** |
| Requête #2, plancher de bruit même-prompt | **168** (`history/message#1`, 23 589 → 23 757) |
| Taille de la requête #1 | 111 056 |
| Signal attendu par `omniris_tuning.md` (~19 K tokens) | **≈ 72 000** (voir ratio ci-dessous) |

Ratio octets↔tokens **dérivé de la capture elle-même** (jamais d'un tokenizer) :
`Anatomy.total / (input + cache_read + cache_creation)` du `usage` capturé —
**3,78–3,79 o/tok** sur la paire haiku (111 056 o / 29 377 tok), **2,57–2,61 o/tok** sur
omniris/opus. Le ratio est **spécifique à la capture** (contenu + modèle) : il sert ici une
seule fois, à mettre bruit et signal sur le même axe. À 3,79 o/tok, 19 K tokens ≈ 72 000 octets.

- Requête #1 : **bruit 0 octet** → rapport signal/bruit **infini**.
- Requête #2 : 72 000 / 168 ≈ **430×**, soit **2,6 ordres de grandeur**.

**Réponse Q4 : un run par bras suffit.** Le seuil « 2 ordres de grandeur » de la fog
« répétabilité statistique » est franchi même au tour 2. Si le banc veut une marge affichable,
la règle défendable est : *un gain est réel s'il dépasse 1 000 octets par bucket* (≈ 6× le
bruit tour-2 mesuré), sans répétition. À réévaluer si le banc passe en interactif ou fait
appel à `Bash` (§5).

---

## 5. Prompt de banc canonique

**Proposition, mesurée :**

```
claude -p "Read the file FIXED.txt and reply with only its first word." \
  --model claude-haiku-4-5-20251001 --permission-mode bypassPermissions
```

avec un `FIXED.txt` **committé** au contenu fixe (ici `kumquat\nlantern\nmarrow\n`).

Pourquoi celui-là, chiffres en main :

- **2 POSTs en une invocation** — le minimum pour l'axe cache (§2), sans session interactive
  ni pilotage de stdin.
- **Contenu conversationnel = 132 octets sur 111 056, soit 0,12 %** — mieux que les 2 % de la
  mesure omniris. Le tour 2 ajoute un `tool_result` de 196 octets, lui aussi fixe.
- **Un appel d'outil forcé, et un seul.** Répondre à Q5 : **non, il ne faut pas interdire les
  outils** — un prompt sans outil donne 1 POST et donc aucun verdict cache auto-causé. Mais il
  faut **forcer exactement un `Read`** :
  - `Read` d'un fichier committé ⇒ `tool_result` **déterministe en octets** (196 o dans les
    deux runs).
  - **Éviter `Bash`** : sa sortie porte des horodatages / pids / chemins temporaires et
    pollue `currentTurn` d'un run à l'autre.
- **`--model claude-haiku-4-5-*`** : coût réel par run mesuré ≈ 29 K tokens de cache write +
  29 K de cache read + ~250 tokens de sortie, sur 2 requêtes.
- **cwd fixe et stable.** Les deux runs neufs sont identiques à l'octet *parce que* rien n'a
  changé dans le cwd entre eux. La paire omniris diffère de 2 930 octets uniquement parce que
  `CLAUDE.md` a été édité entre les deux. Le banc doit donc figer son cwd (un temp repo
  committé, pas le repo de travail) et **ne pas** écrire dedans entre les bras.
- **Mode `-p`, pas interactif** : c'est `-p` qui supprime le `session_id` du chemin scratchpad
  de `system#2` (§3), donc qui rend le préfixe strictement reproductible.

---

## 6. Deux blocages découverts en mesurant (à trancher avant l'impl du banc)

### 6.1 `readUsage()` renvoie `null` sur toute capture réelle — les blobs sont gzippés

Les `.response.sse` capturés commencent par la signature gzip `1f 8b 08 00`. CC envoie
`Accept-Encoding: gzip, deflate, br, zstd`, le proxy relaie et tee les octets bruts, donc le
blob stocké est **compressé**. `readUsage()` (`src/report.js:76`) reçoit du binaire, ne trouve
aucune ligne `data:`, échoue à `JSON.parse`, et renvoie `null`.

Constaté par le probe : `usage readable by readUsage() as captured: 0/2` — puis `after
gunzip: 2/2`. Sur les 5 sessions : **0 exchange sur 11 a un `usage` lisible en l'état.**

Impact direct sur `computeWaste` : `usage == null` ⇒ `cold = true` (`src/waste.js:257`) ⇒
**tout segment réutilisé est compté comme gaspillage**. C'est pourquoi `309efa6b` affiche
`cold=true` et `reusedUncached=93 238 o` au tour 3 tel que chargé, alors qu'avec le `usage`
décompressé le tour 3 est `cold=false`, `reusedUncached=0`, `cacheBoundary=19`.

**Autrement dit : l'axe cache du banc est aujourd'hui inmesurable via `loadSession()`.** Le
probe contourne en gunzippant avant `readUsage()` (~10 lignes). C'est un **bug de capture ou
de report** à ticketer séparément — le banc en dépend de bout en bout.

### 6.2 La granularité `Segment` ne sépare pas L2, L3 et L4

`segmentRequest()` émet **un segment par entrée de `messages[]`**. En `-p`, CC empile les six
injections dans **un seul** message `user` :

```
msg#0(user)/block0   2012 o  hook SessionStart CAVEMAN     ← L2
msg#0(user)/block1   5536 o  hook SessionStart PONYTAIL    ← L2
msg#0(user)/block2   1038 o  listing outils différés/MCP   ← L4
msg#0(user)/block3   2345 o  listing agent types
msg#0(user)/block4   8319 o  listing skills
msg#0(user)/block5   3503 o  <system-reminder> # claudeMd  ← L3
msg#0(user)/block6    132 o  prompt utilisateur
```

Le probe rapporte donc `L2 = L3 = L4 = 22 919 o` (le message entier) : **trois leviers
indiscernables**. Seul L1 est proprement séparé (un slot par outil).

**Le banc a besoin d'une attribution au bloc de contenu**, soit en descendant
`segmentRequest` d'un cran, soit via une couche d'attribution propre au banc. Décision de
forme → map #46 ; sémantique du découpage → [#29](https://github.com/ledahu05/ccsnoop/issues/29).

---

## Réponses aux 5 questions

1. **Visibilité en requête #1** — ✅ **les 4 leviers sont tous présents dans le premier POST**
   (L1 57 577 o, L2 7 548 o, L3 3 503 o, L4 1 038 o sur 111 056 o). **Un run mono-tour suffit
   pour l'axe bloat.** Bonus : deux blocs non listés (skills 8 319 o, agent types 2 345 o)
   pèsent plus que L3+L4.
2. **Ce qui exige ≥ 2 tours** — le `cache_read` du tour 1 est causé par les runs *antérieurs*
   (prouvé : run B relit les 29 367 tokens écrits par run A). **Minimum 2 tours par bras** ;
   l'ordre des bras et la répétition d'un même bras sont des variables du protocole.
3. **Non-déterminisme** — tableau §3. Bougent les octets : état MCP (**−2 584 o**), réponse du
   modèle (**+168 o**), édition de `CLAUDE.md` (**+2 930 o**, pas du bruit). Δ0 octet mais
   **cassent le hash** : `tool_use_id`, build CC dans `system#0`, `session_id` scratchpad
   (interactif seulement). Purement cosmétiques : ordre des clés, `session_id`, timestamps,
   ordre de `tools[]` (stable sur 4 sessions).
4. **Bruit vs signal** — bruit **0 o** en requête #1, **168 o** en requête #2 ; signal ≈
   **72 000 o** (19 K tok × 3,79 o/tok dérivé de la capture). **≈430×, 2,6 ordres de
   grandeur → un run par bras suffit** ; seuil de gain réel proposé : > 1 000 o par bucket.
5. **Prompt canonique** — `Read the file FIXED.txt and reply with only its first word.` sur un
   fichier committé, en `-p`, haiku : 2 POSTs, contenu conversationnel 0,12 %, `tool_result`
   déterministe. **Interdire les outils serait une erreur** (1 POST, aucun verdict cache) ;
   forcer **exactement un `Read`**, jamais `Bash`.

## Reproduire

```bash
node docs/research/probes/bench-run-comparability-probe.mjs \
  /tmp/ccsnoop-b2/.ccsnoop/sessions/645c6781-6067-4ee7-947f-9c6d317ed2a1 \
  /tmp/ccsnoop-b2/.ccsnoop/sessions/db1db459-b039-47b1-ad73-aa7adf6f2338
```

Les runs neufs ont été faits dans un temp repo (`/tmp/ccsnoop-b2`) routé par
`ccsnoop init`, puis `ccsnoop init --undo` ; le daemon de la machine et la route de
l'utilisateur n'ont pas été touchés.
