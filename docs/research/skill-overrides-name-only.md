# `skillOverrides: name-only` mesuré sur le fil — confirmation de la réserve d'ADR-0005

Ticket : [issue #115](https://github.com/ledahu05/ccsnoop/issues/115) — tranche 0 du levier 5,
préalable à [#116](https://github.com/ledahu05/ccsnoop/issues/116),
[#118](https://github.com/ledahu05/ccsnoop/issues/118) et
[#119](https://github.com/ledahu05/ccsnoop/issues/119). Lève la réserve posée par
[ADR-0005](../adr/0005-skills-catalog-lever-name-only.md).

**Verdict court : les trois faits tiennent, et le mécanisme récupère bien les octets.** Sur le
fil, une entrée passée en `name-only` tombe à **exactement sa ligne de nom** — `dataviz`
**1 157 → 10 octets (−99,1 %)**, une skill de projet **674 → 14 octets (−97,9 %)** — et le bloc
`skills-catalog` entier perd **1 843 octets sur 5 744 (−32,1 %)** en ne désignant que deux skills
sur douze. **Résidu nul** : aucune des deux descriptions retirées ne reparaît ailleurs dans la
requête. La skill reste listée, et `/nom` reste tapable.

Le gain du levier 5a n'est donc plus postulé. Il est mesuré.

**Trois réserves à porter dans les tranches suivantes**, détaillées plus bas : l'exemption plugin
reste une lecture **statique** (rien à mesurer, par construction) ; `parseCatalogEntries` ne savait
pas lire une entrée `name-only` (**corrigé ici**) ; et `floor` s'ancre au mauvais tour sur une
capture `-p` ([#120](https://github.com/ledahu05/ccsnoop/issues/120)).

Toutes les tailles sont des **OCTETS** (`findCatalogBlocks` / `parseCatalogEntries`, le parseur du
repo). Aucune re-tokenisation.

---

## 0. Environnement

| Élément | Valeur |
|---|---|
| Lectures binaires | **`2.1.220`** (la version épinglée par `bench/SPEC.md` §0, tirée de `@anthropic-ai/claude-code-linux-x64@2.1.220`) **et `2.1.224`** (le build local) |
| Mesure sur le fil | `2.1.224` — le seul binaire installé sur ce poste |
| Modèle | `claude-haiku-4-5-20251001`, `-p`, `--permission-mode bypassPermissions`, `ENABLE_TOOL_SEARCH=true` |
| Harnais | [`probes/skill-overrides-probe.mjs`](./probes/skill-overrides-probe.mjs) — importe `findCatalogBlocks` / `parseCatalogEntries` de `src/floor-catalog.js`, `loadSession` / `computeAnatomy` de `src/report.js`. Pas de second parseur. |

**La dérive annoncée dans la réserve a bien commencé** — le bench épingle `2.1.220`, le poste est à
`2.1.224` — mais sur les quatre lectures qui portent le levier 5, les deux versions sont
**identiques**, et les chaînes de schéma sont **byte-identiques**. La mesure sur le fil n'a pu être
faite que sur `2.1.224` ; c'est la seule asymétrie qui subsiste, et elle est bénigne puisque le code
de rendu est le même dans les deux builds (§4).

**Correction de forme à ADR-0005.** L'ADR attribue ses lectures à « v2.1.220 » mais cite les
symboles `p4e`, `ho`, `O4_` : ce sont ceux de **2.1.224**. Sur 2.1.220 le même code se minifie en
`jFe`, `eo`, `sPy`. Le fond est intact — c'est le même code, aux noms de symboles près, ce que la
double lecture ci-dessous établit.

---

## 1. Fait 1 — `skillOverrides` existe, enum à 4 membres — ✅ confirmé sur 2.1.220

Verbatim, extrait du binaire **2.1.220** :

```js
skillOverrides:v.record(v.string(),v.enum(["on","name-only","user-invocable-only","off"]))
  .optional().describe('Per-skill listing overrides keyed by skill name. "name-only" lists the
  skill without its description; "user-invocable-only" hides it from the model but keeps /name;
  "off" hides it from both. Absent = on.')
```

Sur **2.1.224**, la chaîne `describe` est **byte-identique** et le tableau
`["on","name-only","user-invocable-only","off"]` apparaît 4 fois (schéma + UI `/skills`).

**Ce que ça verrouille pour #118** : la branche objet de `safeMergeSettings` peut contraindre ses
valeurs à cet enum de 4 membres sans risque de le voir s'élargir sous les pieds — au moins sur
l'intervalle 2.1.220 → 2.1.224.

## 2. Fait 2 — les skills de plugin sont exemptes — ✅ confirmé, statiquement

Résolveur **2.1.220** (`jFe`), verbatim :

```js
function jFe(e){
  if((e.type==="local-jsx"||e.type==="local") && sPy.has(e.name))
    return eo().skillOverrides?.[e.name]==="off" ? "off" : "on";
  if(e.type!=="prompt" || e.source==="plugin") return "on";          // ← plugin : override ignoré
  let t=eo(), r=t.skillOverrides,
      n = r?.[e.name] ?? (e.unqualifiedName!=null ? r?.[e.unqualifiedName] : undefined) ?? "on";
  if(Doo(e,t)) return n==="off" ? "off" : "user-invocable-only";
  return n
}
```

**2.1.224** : même corps, symboles `p4e` / `ho` / `JCo`. La ligne d'exemption est identique au
caractère près.

⚠ **Limite assumée : cette confirmation est statique, et le restera.** Aucun plugin n'est installé
sur le poste de mesure, et il n'y a rien à mesurer : le résolveur retourne `"on"` **avant** toute
lecture des settings, donc une skill de plugin ne peut, par construction, produire aucun delta
d'octets. Le probe pose la seule cellule négative disponible — un `skillOverrides` sur un nom
inexistant, sans effet (§5) — pour que le négatif figure au dossier plutôt que d'être inféré.
**C'est la prémisse du tier `advice` de la tranche [#119](https://github.com/ledahu05/ccsnoop/issues/119),
et elle repose sur une lecture de code, pas sur une mesure.**

## 3. Fait 3 — les skills intégrées ne sont pas incompressibles — ✅ confirmé, avec une nuance

```js
function bV(e){ return Z.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS || (e??eo()).disableBundledSkills===!0 }
function Doo(e,t){ return e.type==="prompt" && e.source==="builtin" && bV(t) }
```

Les deux voies existent, et le `describe` de `disableBundledSkills` (byte-identique sur les deux
versions) précise le périmètre :

> Disable the skills and workflows that ship with Claude Code: bundled skills and workflows are
> removed entirely; built-in slash commands stay typable but are hidden from the model. **Plugins,
> `.claude/skills/`, and `.claude/commands/` are unaffected.**

Et surtout, la troisième voie : `Doo` n'est consulté qu'**après** la lecture de `skillOverrides`, si
bien qu'une entrée par nom atteint une skill bundled tant que `disableBundledSkills` est faux. C'est
ce que la mesure du §4 vérifie directement — **`dataviz` est une skill bundled**, et son override
`name-only` mord.

**Nuance mesurée (§5)** : `disableBundledSkills: true` retire les skills bundled **des deux**
inventaires — modèle *et* slash-commands. La formule « built-in slash commands stay typable » vise
les commandes intégrées (`/config`, `/model`…), pas les skills bundled. Un verdict `disableBundledSkills`
en tier advice (#119) doit donc être présenté comme **la perte de `/dataviz` aussi**, pas seulement
d'une description.

## 4. Le mécanisme de rendu — pourquoi la récupération est exactement la description

Le code qui construit le catalogue, **2.1.220** :

```js
let i = new Set(e.filter((u) => jFe(u) === "name-only").map((u) => u.name)),
    s = ZWu(e, …), a = new Set(s.budgetTruncatedSkills), l = RMt();
for (let u of e) {
  let d = i.has(u.name) || a.has(u.name) ? `- ${u.name}` : `- ${u.name}: ${DMt(u).slice(0, l)}`;
  …
}
```

Deux choses en découlent, et les deux comptent pour ccsnoop :

1. **`name-only` produit exactement `- <nom>`.** Pas de description tronquée, pas de résidu. La
   récupération est la description entière, moins rien.
2. **`budgetTruncatedSkills` produit la même forme.** Claude Code dégrade lui-même ses plus grosses
   entrées en `- <nom>` quand son budget de catalogue déborde — **sans aucun réglage utilisateur**.
   La forme `- <nom>` n'est donc pas une curiosité de settings : elle apparaît dans des captures
   d'utilisateurs qui n'ont jamais touché à `skillOverrides`.

Le point 2 a une conséquence immédiate, traitée au §7.

## 5. Instrument A — la matrice `system/init`, zéro token facturé

`ANTHROPIC_BASE_URL` sur un port mort : Claude Code charge tous les scopes de settings, émet
`system/init` (qui porte `skills` **et** `slash_commands`), puis meurt. Six cellules, six settings.

| Cellule | `skills` | `slash_commands` | `/dataviz` tapable | `/probe-heavy` tapable |
|---|---:|---:|:--:|:--:|
| control | 16 | 42 | ✅ | ✅ |
| `name-only` sur les 2 cibles | 16 | 42 | ✅ | ✅ |
| `user-invocable-only` sur les 2 | 16 | 42 | ✅ | ✅ |
| `off` sur les 2 | **14** | **40** | ❌ | ❌ |
| `disableBundledSkills: true` | **2** | **28** | ❌ | ✅ (projet, épargnée) |
| override sur un nom inexistant | 16 | 42 | ✅ | ✅ |

**Ce que ça établit** — la frontière `off` / le reste. `off` retire la skill des deux inventaires ;
`name-only` ne retire rien. C'est la moitié « action bornée » de la thèse d'ADR-0005 : sous
`name-only`, `/nom` marche encore.

⚠ **Plafond de l'instrument, à ne pas surinterpréter.** La cellule `user-invocable-only` laisse la
skill dans `skills` alors que le résolveur la cache manifestement au modèle. **`system/init.skills`
n'est donc pas la liste vue par le modèle** : c'est le registre. Cet instrument sait dire « la skill
existe-t-elle encore », pas « sa description a-t-elle été expédiée ». Seul le fil répond à ça — d'où
l'instrument B.

## 6. Instrument B — la mesure sur le fil

Deux bras live, ne différant **que** par `<arm>/.claude/settings.json` (canal `CLAUDE_CONFIG_DIR`),
même cwd, même prompt canonique de B2, lancés séquentiellement, un run par bras.

| Bras | `settings.json` |
|---|---|
| control | `{}` |
| name-only | `{"skillOverrides":{"dataviz":"name-only","probe-heavy":"name-only"}}` |

Deux scopes, tous deux atteignables par `skillOverrides` : **`dataviz`** est une skill **bundled**
(la plus lourde du scope d'après le relevé manuel de #105), **`probe-heavy`** est une skill de
**projet** écrite dans le dépôt fixture. Le scope **utilisateur** n'est pas mesuré séparément : il
emprunte exactement la même branche du résolveur que le scope projet (`type === "prompt"`,
`source !== "plugin"`).

### Résultat

| | control | name-only | delta |
|---|---:|---:|---:|
| bloc `skills-catalog` (canonique) | **5 744 o** | **3 901 o** | **−1 843 o (−32,1 %)** |
| entrées listées | 12 | **12** | 0 |
| `- dataviz: …` (bundled) | **1 157 o** | **10 o** | −1 147 o (**−99,1 %**) |
| `- probe-heavy: …` (projet) | **674 o** | **14 o** | −660 o (**−97,9 %**) |

`10` et `14` octets sont **exactement** `- dataviz\n` et `- probe-heavy\n`. L'entrée ne coûte plus
que son nom — ce que §4 prédisait, vérifié sur le fil et non déduit du code.

**Résidu : nul.** Les 60 premiers caractères de chacune des deux descriptions retirées apparaissent
**0 fois** dans la requête du bras `name-only`. Rien n'est ré-expédié ailleurs.

### Réconciliation — 1 843 contre 1 807

Les entrées perdent 1 807 octets **bruts** ; le bloc en perd 1 843 **canoniques**. L'écart de 36
octets est exactement le nombre de caractères `"` de la description de `dataviz` (36), chacun
échappé en `\"` dans le JSON canonique. Rien n'est inventé, rien n'est perdu : le bloc est mesuré
comme JSON échappé (la base de toutes les lignes de `floor`), les entrées comme texte brut.
**À porter dans #118** : un verdict qui annonce des octets récupérés doit dire lesquels des deux il
compte — le gain réel sur le fil est le chiffre canonique, le plus grand des deux.

### Ce que `name-only` récupère par rapport à `off`

`off` supprimerait l'entrée entière (10 et 14 octets de plus). `name-only` récupère donc **99,2 %**
de ce que `off` récupérerait, **sans** retirer la skill ni casser `/nom`. C'est la justification
chiffrée du choix d'ADR-0005 : l'action plus douce ne coûte presque rien en récupération.

---

## 7. Ce que la mesure a changé dans le code

**`parseCatalogEntries` ne savait pas lire une entrée `name-only`.** Le motif d'entrée était
`/^-\s+([^:]+):\s*(.*)$/` — un deux-points obligatoire. Une ligne `- dataviz` n'y correspondait pas
et tombait dans la branche « ligne de continuation » : ses octets étaient **facturés à l'entrée
précédente**, ou la ligne disparaissait purement si aucune entrée ne la précédait. Le probe l'a
révélé en essayant de mesurer ce qu'il venait de créer.

Ce n'est pas un artefact de probe. Par le §4, la même forme sort du **budget de catalogue de Claude
Code**, sans aucun réglage — et `/skills` écrit `skillOverrides` de son côté. Un utilisateur pouvait
donc déjà voir, dans `floor --detail`, une skill en usage grossie des octets de sa voisine muette.

Corrigé dans `src/floor-catalog.js` par un motif tenté **avant** le motif bulleté :

```js
const NAME_ONLY_ENTRY = /^-\s+([A-Za-z0-9_.:-]+)\s*$/;
```

Le discriminant est volontairement serré — **un seul token nu après le tiret, sans espace** — pour
qu'une ligne de continuation en prose commençant par `- ` continue de se replier dans l'entrée du
dessus. Les deux propriétés sont figées par test (`test/floor.test.js`, « a name-only skill is its
own entry » et « a bulleted description is never mistaken for a name-only entry »). Le motif tolère
le deux-points **à l'intérieur** du token, si bien qu'un nom qualifié (`plugin:skill` — la forme que
la troncature budgétaire peut produire sur une skill de plugin) reste entier au lieu d'être coupé à
son deux-points.

## 8. Ce qui reste ouvert

1. **`floor` s'ancre au mauvais tour sur une capture `-p`** —
   [#120](https://github.com/ledahu05/ccsnoop/issues/120), remonté par ce probe. Le tour 1 de ces
   captures est un aller-retour auxiliaire **sans aucun outil** (2 340 o) ; `computeFloor` s'y ancre
   et annonce « no catalog blocks » sur une session qui en porte trois. Toutes les mesures de cette
   note passent par le probe, qui sélectionne lui-même la première requête à `tools[]` non vide —
   c'est précisément ce contournement qui devrait descendre dans `computeFloor`.
2. **L'exemption plugin reste statique** (§2). Si #119 veut une preuve sur le fil, il lui faut un
   plugin installé sur le poste de mesure.
3. **La mesure n'a été faite que sur 2.1.224.** Les lectures statiques couvrent 2.1.220 et 2.1.224 ;
   le code de rendu du §4 est identique dans les deux, donc rien ne laisse attendre un delta
   différent. À re-mesurer si le bench dégèle sa version épinglée.
4. **Un run par bras.** Le plancher de bruit mesuré en B2 est de 0 o entre deux runs identiques,
   ce qui autorise le run unique ; les deltas relevés ici (−1 147 o sur une entrée) sont de toute
   façon hors de portée du bruit.

## 9. Aparté — un `#` dans une description de skill la tronque en silence

Le premier tirage de ce probe a mesuré une entrée projet à 83 o au lieu de 674. Cause : la
description de la skill fixture était un scalaire YAML **non quoté** contenant `#115`, et en YAML
un ` #` ouvre un commentaire. Claude Code a listé les 66 premiers caractères et rien d'autre, sans
avertissement.

Sans conséquence pour le levier — mais quiconque mesure le coût d'un catalogue doit le savoir : une
description peut être bien plus courte sur le fil que dans le `SKILL.md`, et le raccourci ne vient
alors ni d'un override ni du budget.
