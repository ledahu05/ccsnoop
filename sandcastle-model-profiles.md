# Profils de modèles Sandcastle — décisions de conception

Compte-rendu d'une session de grilling sur la question : **faire tourner les 4 agents
Sandcastle de `.sandcastle/main.ts` entièrement sur Opus, tout en conservant la
possibilité de basculer facilement vers la configuration « 3 premiers agents sur GLM,
le dernier sur Opus ».**

Critère décisif posé d'entrée par le demandeur : **la facilité de switcher d'un mode à
l'autre**. Chaque arbitrage ci-dessous a été tranché avec ce critère comme juge de paix.

Ce document est autoportant : il sert autant de spec d'implémentation pour ccsnoop que
de recette à dupliquer dans un autre projet utilisant `@ai-hero/sandcastle`. La section
[Reproduire ailleurs](#reproduire-dans-un-autre-projet) isole ce qui est spécifique à
ccsnoop de ce qui est générique.

- **Date** : 2026-07-28
- **Périmètre** : `.sandcastle/` (orchestration RALPH), pas le produit ccsnoop
- **ADR de référence** : `docs/adr/0001-sandcastle-cross-provider-split.md`

---

## 1. État de départ

`.sandcastle/main.ts` est un loop RALPH (itère jusqu'à épuisement, commits préfixés
`RALPH:`) avec quatre rôles d'agents :

| Rôle | Exécution | Provider actuel |
|---|---|---|
| Planner | head mode (`sandcastle.run`) | z.ai — `glm-5.2[1m]` |
| Implementer | worktree (`createSandbox({branch})`) | z.ai — `glm-5.2[1m]` |
| Reviewer | worktree séquentiel, **même branche** | Anthropic — `claude-opus-4-8` |
| Merger | head mode | z.ai — `glm-5.2[1m]` |

Deux constantes (`IMPL_MODEL`, `REVIEW_MODEL`), deux fabriques d'env
(`zaiEnv()`, `anthropicEnv()`), un `loadSecrets()` qui lit `.sandcastle/.env.secrets`,
et un bloc `SANDCASTLE_DRYRUN` qui imprime le câblage sans lancer d'agent.

Deux mécanismes de l'ADR-0001 qu'il faut avoir en tête :

- **S1 — isolation des tokens.** Le `resolveEnv` de sandcastle fusionne **toutes** les
  clés de `.sandcastle/.env` dans **tous** les sandboxes, et `docker({env})` ne peut
  qu'**ajouter** des clés, jamais en retirer. Deux tokens d'auth dans `.env` fuiteraient
  donc partout → claude-code enverrait le mauvais token contre la mauvaise base URL →
  401. D'où : `.env` ne garde que `GH_TOKEN`, et les tokens vivent dans `.env.secrets`
  (gitignoré, non lu par `resolveEnv`), que `main.ts` lit lui-même pour baker exactement
  un token par sandbox.
- **A2 — deux worktrees séquentiels par issue.** L'Implementer tourne dans un worktree
  sur la branche, `close()`, puis le Reviewer dans un **second** worktree sur la **même**
  branche avec un env provider différent. `close()` supprime le chemin du worktree mais
  conserve la ref de branche et les commits, donc le `createSandbox({branch})` du
  Reviewer checkout la branche existante et voit le travail d'implémentation.

L'ADR-0001 se termine sur un invariant : *« the reviewer must be a different model than
the implementer »*. Le profil tout-Opus le viole frontalement — c'est l'objet de la
décision 8.

---

## 2. Les neuf décisions

### D1 — Nature du mode tout-Opus : **deux régimes de qualité égaux**

Trois lectures étaient possibles : échappatoire opérationnelle (z.ai indisponible),
deux régimes au choix, ou nouveau nominal.

**Retenu** : deux régimes de qualité égaux, choisis **run par run** selon l'enjeu du
ticket (tout-Opus pour les tickets sensibles, split pour le volume et le coût).
**`split` reste le défaut.**

*Pourquoi* : la demande est formulée comme « pouvoir switcher facilement dans les deux
sens », pas « remplacer ». Un simple échappatoire ne mériterait pas d'exigence de
facilité de bascule (on éditerait deux constantes). Et faire de tout-Opus le nominal
obligerait à justifier l'abandon de l'invariant de diversité, ce que rien ne demande.
Ce cadrage est aussi le seul qui fasse du *choix* — et pas seulement de la bascule — un
acte de première classe : le profil devient un paramètre du run, pas un état du fichier.

### D2 — Surface de bascule : **variable d'environnement**

`SANDCASTLE_PROFILE=opus npx tsx .sandcastle/main.ts`, avec deux scripts npm comme
façade découvrable, et un `throw` immédiat sur valeur inconnue.

**Rejeté : éditer une constante dans `main.ts`.** Argument décisif : Planner et Merger
tournent en *head mode*, c'est-à-dire dans le dépôt hôte lui-même. Un `main.ts` modifié
non commité est dans leur arbre de travail pendant tout le run, et le Merger commite. La
bascule par édition fabrique donc un risque permanent de commiter l'état de bascule — et
pire, un `git stash`/reset mal placé rebascule le mode sans que personne ne le remarque.

Deux arguments d'appoint : `main.ts` lit déjà `process.env.SANDCASTLE_DRYRUN`, donc
`SANDCASTLE_PROFILE` prolonge un idiome existant et se compose avec lui
(`SANDCASTLE_PROFILE=opus SANDCASTLE_DRYRUN=1 …` pour vérifier avant de brûler des
tokens) ; et le profil apparaît dans l'historique shell, donc « ce run tournait en quel
mode ? » devient répondable.

**Rejeté : argument CLI** (demande un parseur là où il n'y en a aucun, ne se compose pas
homogènement avec `SANDCASTLE_DRYRUN`). **Rejeté : fichier de conf séparé** (un fichier,
un format, un chemin de lecture et une question de gitignore pour zéro gain).

### D3 — Contenu du profil : **{modèle, base URL, token} par provider**

Le profil ne porte pas seulement des noms de modèles : il porte le triplet complet.
C'est ce triplet qui se bake dans un `docker({env})`.

### D4 — Granularité : **par rôle (4 clés), pas par camp (2 clés)**

`{ planner, implementer, reviewer, merger }` → chacun nomme un provider.

*Pourquoi* :

1. **Les deux profils deviennent purement déclaratifs.** Un profil est une table de 4
   lignes ; basculer, c'est lire une autre table. **Aucune branche
   `if (profile === …)` ne survit dans le corps du loop.** C'est exactement le critère
   décisif : la facilité de bascule se mesure au nombre d'endroits où le mode est
   *interrogé*, et cette forme le réduit à zéro.
2. **Ça nomme un fait aujourd'hui muet.** `IMPL_MODEL` prétend qu'il existe un « côté
   implémentation » ; en réalité trois rôles partagent un provider. Par camp, on grave la
   confusion dans la structure ; par rôle, le partage devient visible comme *valeur
   répétée*, pas comme *identité*.
3. **Coût nul, configs intermédiaires gratuites.** « Planner sur Opus, Implementer sur
   GLM, Reviewer sur Opus » ne demande aucun code nouveau — juste une troisième table.

### D5 — Topologie : **deux worktrees séquentiels conservés dans les deux profils**

En tout-Opus, les deux env sont identiques : le second spin-up n'achète plus rien côté
provider. On le garde quand même, **sans condition**.

Argument d'en face, réel : en tout-Opus on paie un spin-up Docker + un `npm ci` par
issue pour rien. C'est du temps mur pur.

*Pourquoi on garde malgré tout* :

1. **Collapser réintroduit ce que D4 vient d'éliminer** : un
   `if (sameProvider(implementer, reviewer))` dans le corps du loop, donc une branche
   exercée dans un seul mode. Un bug dedans est invisible dans l'autre mode, et « facile
   à switcher » ne veut plus rien dire si les deux modes ne parcourent pas le même chemin.
2. **Le collapse n'est pas neutre sémantiquement.** Un worktree frais checkout la branche
   *telle qu'elle a été commitée*. Dans le sandbox de l'Implementer, le Reviewer
   hériterait de ses fichiers non suivis et de son état sale. Or `review-prompt.md`
   travaille sur `git diff main..HEAD` : la revue cesserait de porter sur « ce qui a
   atterri sur la branche » pour porter sur « ce que l'Implementer a laissé traîner ».
   Dérive silencieuse, visible uniquement en tout-Opus.
3. **Le coût est déjà accepté.** L'ADR-0001 liste ce double `npm ci` comme conséquence
   négative assumée, revue best-effort, `MAX_PARALLEL=4` inchangé.

### D6 — Identifiant de modèle Opus : **constante unique, valeur `claude-opus-5`**

`const OPUS_MODEL = "claude-opus-5"` — une seule constante nommée, référencée par le
descripteur de provider, changeable en un mot.

Contexte de catalogue au moment de la décision : `claude-opus-5` est l'Opus courant, au
**même tarif** que 4.8 ($5/$25 par MTok), 1M de contexte, upgrade drop-in.
`claude-opus-4-8` reste actif (génération précédente, pas retiré). Les ids sont exacts
tels quels, **sans suffixe de date**.

**Conséquence à traiter séparément** (voir §4) : Opus 5 **vérifie son propre travail sans
qu'on le lui demande**. Les consignes de vérification explicite (« double-check »,
« re-verify ») deviennent contre-productives et produisent de la sur-vérification. Or
`review-prompt.md` est précisément un prompt de vérification → il demande une passe de
relecture pour *retirer* ces consignes. C'est une conséquence du changement de modèle,
indépendante du mécanisme de profils.

### D7 — Validation des tokens : **au démarrage, restreinte aux providers du profil actif**

Parcourir les providers distincts du profil actif, exiger le token de chacun, ignorer les
autres. Message d'erreur nommant le profil **et** la clé.

État de départ à corriger : `need()` n'est appelé qu'à la construction de l'env, donc au
démarrage d'un sandbox. Un token manquant ne se manifeste qu'au premier `createSandbox`.

*Pourquoi* :

1. **Le mode de défaillance paresseux est cher et silencieux.** Le Reviewer tourne
   *après* l'Implementer, par issue, à l'itération N. Un `CLAUDE_CODE_OAUTH_TOKEN` absent
   ou expiré ne se révèle donc qu'après un cycle d'implémentation complet — et comme la
   revue est best-effort (`catch` qui log et continue), l'échec est **avalé** : le run
   continue, merge, et personne ne voit que la revue n'a jamais eu lieu. Tard *et*
   silencieux. Un check au démarrage transforme ça en un `throw` d'une ligne.
2. **Valider les deux tokens dans tous les cas rendrait tout-Opus dépendant d'un secret
   dont il n'a aucun usage.** Exiger une clé z.ai valide pour un run qui ne touche jamais
   z.ai, c'est un couplage gratuit — et exactement le genre de friction qui fait qu'on ne
   bascule pas.

### D8 — Invariant de diversité : **ADR-0002 qui amende l'ADR-0001**

L'ADR-0001 reste `Accepted`, avec un pointeur d'une ligne sur sa ligne d'invariant.
ADR-0002 documente le mécanisme de profils et la forme conditionnelle de l'invariant.

**Rejeté : éditer l'ADR-0001 en place.** Un ADR est le compte-rendu d'une décision
*datée* ; l'éditer efface le raisonnement d'origine — or celui de l'ADR-0001 est précieux
(le piège du `resolveEnv`, le rejet de l'alternative « blank-override », la vérification
du fallback worktree dans le dist minifié) et reste entièrement valable.
**Rejeté : ADR-0002 qui remplace l'ADR-0001** — la décision A2/S1 n'est pas remplacée,
elle est *généralisée*.

Formulation retenue de l'invariant :

> **Invariant (conditionnel)** — en profil `split`, le reviewer doit utiliser un modèle
> différent de l'implementer. En profil `opus`, cette garantie est délibérément
> abandonnée : la revue ne conserve que la diversité de contexte (contexte frais, prompt
> distinct, worktree isolé). C'est le prix assumé du profil ; le profil `split` reste le
> régime nominal.

**Aucun mécanisme compensatoire** en tout-Opus (pas d'`effort` différencié, pas de prompt
de revue plus adversarial). La dégradation est nommée honnêtement et acceptée : deux
instances du même modèle partagent leurs angles morts par construction.

### D9 — Couture testable : **aucune**

Pas de tests, et donc pas d'extraction de module : la seule justification avancée pour
extraire un `model-profile.ts` était la testabilité. Tout reste inline dans `main.ts`, et
`SANDCASTLE_DRYRUN` fait office de vérification.

*Pour mémoire, ce qui aurait mérité un test si on en avait voulu* — et seulement ça, car
`.sandcastle/CODING_STANDARDS.md` proscrit explicitement les tests qui recopient
l'implémentation (« BAD: test restates the implementation — the function IS the spec ») :
un profil inconnu lève ; un token manquant pour un provider **référencé** lève ; un token
manquant pour un provider **non référencé** ne lève **pas**.

**Limite connue, hors périmètre** : `.sandcastle/` est hors du `include` de
`tsconfig.json` (`["bin", "src", "test"]`), donc non couvert par `npm run typecheck`.

---

## 3. Vocabulaire

| Terme | Définition |
|---|---|
| **Profil de modèles** (`profile`) | La table qui affecte un provider à chaque rôle. |
| **Provider** | Le triplet {identifiant de modèle, base URL, token}. C'est ce qui se bake dans un `docker({env})`. |
| **Rôle** | planner / implementer / reviewer / merger. |

Pas « mode » : `CONTEXT.md` proscrit déjà ce mot pour la *portée de capture*, et
réutiliser le même terme pour un second concept dans le même dépôt est exactement la
collision que ce glossaire existe pour éviter.

Ces termes **ne vont pas dans `CONTEXT.md`** : ce glossaire est la langue du produit
ccsnoop (portée de capture, racine de capture, route token), et l'ADR-0001 se déclare
lui-même hors de ce périmètre. Ils vivent dans l'ADR et dans le code.

---

## 4. Forme du code

Deux tables et deux accesseurs remplacent `IMPL_MODEL` / `REVIEW_MODEL` / `zaiEnv()` /
`anthropicEnv()`.

```ts
const OPUS_MODEL = "claude-opus-5";
const GLM_MODEL  = "glm-5.2[1m]";
const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

const PROVIDERS = {
  zai:       { model: GLM_MODEL,  tokenKey: "ANTHROPIC_AUTH_TOKEN",    baseUrl: ZAI_BASE_URL },
  anthropic: { model: OPUS_MODEL, tokenKey: "CLAUDE_CODE_OAUTH_TOKEN", baseUrl: null },
};

const PROFILES = {
  split: { planner: "zai",       implementer: "zai",       reviewer: "anthropic", merger: "zai" },
  opus:  { planner: "anthropic", implementer: "anthropic", reviewer: "anthropic", merger: "anthropic" },
};
```

**Résolution du profil** (au démarrage, avant tout agent) :

1. `process.env.SANDCASTLE_PROFILE ?? "split"`.
2. Nom absent de `PROFILES` → `throw` (pas de retombée silencieuse sur `split`).
3. Pour chaque provider **distinct** référencé par le profil actif : exiger
   `secrets[provider.tokenKey]`, sinon `throw` en nommant le profil et la clé.

**`envFor(role)`** émet :

- `ANTHROPIC_BASE_URL` **seulement** si `baseUrl` est non nul (l'absence de la clé est ce
  qui fait taper claude-code sur `api.anthropic.com`) ;
- le token sous sa `tokenKey` — donc exactement un token par sandbox, ce qui préserve S1 ;
- les trois `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` au `model` du provider.

**`modelFor(role)`** alimente `sandcastle.claudeCode(...)`.

Les quatre appels d'agents passent de `zaiEnv()` / `anthropicEnv()` à `envFor("planner")`,
`envFor("implementer")`, `envFor("reviewer")`, `envFor("merger")` — et de `IMPL_MODEL` /
`REVIEW_MODEL` à `modelFor(<rôle>)`.

**`SANDCASTLE_DRYRUN`** étendu : profil actif, table rôle → provider, modèle par rôle,
présence des tokens requis.

---

## 5. Travaux annexes

Tâches distinctes du mécanisme de profils, à traiter séparément :

1. **`review-prompt.md`** — retirer les consignes de vérification explicite
   (« double-check », « re-verify ») : Opus 5 vérifie spontanément et ces consignes
   produisent de la sur-vérification. Conséquence du passage 4.8 → Opus 5.
2. **ADR-0002** + pointeur d'une ligne dans l'ADR-0001.
3. **`.env.secrets.example` / `.env.example`** — les commentaires affectent les tokens à
   des rôles fixes (« z.ai : planner / implementer / merger », « Anthropic : reviewer »).
   À reformuler par profil, avec la règle « seul le token des providers du profil actif
   est requis ».
4. **`docs/agents/ticket-lifecycle.md`** — dit encore « Each phase is a headless
   `claude-opus-4-8` agent », ce qui est **déjà faux** avant ce chantier (trois rôles sur
   GLM depuis l'ADR-0001). Dérive documentaire à corriger au passage.
5. **`package.json`** — deux scripts npm comme façade de bascule.

---

## 6. Reproduire dans un autre projet

### Prérequis

- Un `.sandcastle/main.ts` avec plusieurs rôles d'agents et **au moins deux providers**
  (sinon il n'y a pas de profil à faire varier).
- Le pattern d'isolation des tokens : les secrets d'auth **hors** de `.sandcastle/.env`,
  dans un fichier lu par `main.ts` lui-même. Sans ça, D7 et l'émission d'un seul token
  par sandbox n'ont pas de support. C'est la contrainte S1 de l'ADR-0001 et elle est
  générique à `@ai-hero/sandcastle`, pas propre à ccsnoop.

### Générique — transposable tel quel

- **D1** le cadrage « régimes au choix, l'un reste nominal » ;
- **D2** la bascule par variable d'environnement, avec l'argument head-mode/dépôt sale
  (valable dès qu'un agent tourne en head mode) ;
- **D3/D4** provider = triplet, affectation par rôle, zéro `if` dans le loop ;
- **D5** garder une topologie identique entre profils ;
- **D6** constante de modèle unique et découplée ;
- **D7** validation au démarrage restreinte aux providers actifs, avec l'argument
  « échec tardif *et* avalé » (valable dès qu'une phase est best-effort) ;
- **D8** amender plutôt que réécrire l'ADR ; nommer honnêtement la dégradation ;
- la **forme du code** du §4 dans son intégralité.

### Spécifique à ccsnoop — à réévaluer

- Les valeurs : `glm-5.2[1m]`, `claude-opus-5`, l'URL z.ai, les noms de clés de token.
- Les **quatre rôles** : un loop à trois ou cinq phases change la table, pas la méthode.
- La topologie **deux worktrees séquentiels par issue** (décision A2 de l'ADR-0001) :
  D5 dit « garder la topologie existante identique entre profils », pas « adopter celle-là ».
- Le choix de **ne pas tester** (D9) et de **ne pas toucher au `tsconfig.json`** : arbitrages
  locaux, pas des recommandations.
- Le refus de mettre le vocabulaire dans `CONTEXT.md` : dépend de la frontière
  produit/outillage du dépôt cible.
- La dérive documentaire du §5.4 : propre à ccsnoop.

### Ordre d'implémentation suggéré

1. Tables `PROVIDERS` / `PROFILES` + résolution du profil + validation D7.
2. `envFor` / `modelFor`, puis remplacement aux quatre points d'appel.
3. Extension du `SANDCASTLE_DRYRUN`, et vérification des deux profils en dry-run.
4. Scripts npm.
5. ADR-0002 + pointeur ADR-0001.
6. Documentation (`.env*.example`, doc de cycle de vie).
7. Relecture de `review-prompt.md` pour Opus 5 (indépendant, peut se faire avant ou après).
