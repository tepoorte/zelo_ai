# Discover Meals Training

Ce dossier entraîne réellement le moteur local `discover_meals`.

- `query_intents.jsonl` contient les phrases client annotées manuellement.
- `product_roles.jsonl` ajoute des rôles métier validés à certains produits ou familles de produits.
- `proposal_examples.jsonl` contient des propositions complètes positives/négatives.
- `proposal_ranking.jsonl` et `ranking_examples.jsonl` guident les rôles acceptés/rejetés.
- `train_model.py` scanne tout le catalogue, construit les profils produits, mine les hard negatives, entraîne le classifieur d’intention et le ranker produit, puis écrit `.cache/discover-meals-model.json`.

Commande normale:

```bash
npm run train:discover-meals
```

Commande complète:

```bash
npm run train:discover-meals -- --full
```

## Synchroniser le catalogue réel

Avant un retraining sérieux, synchroniser le snapshot local depuis l'API
Swissdata production. Le premier passage est toujours un dry-run avec rapport
et sanity checks:

```bash
npm run sync:discover-catalog
```

Si le rapport est sain, appliquer la synchronisation. Le script sauvegarde
d'abord les anciens artifacts Discover dans `.cache/backups/`:

```bash
npm run sync:discover-catalog:apply
```

Pipeline complète locale, sans toucher aux intents:

```bash
npm run refresh:discover-meals
```

Si l'audit UI budget doit être ignoré parce que le serveur local n'est pas
démarré:

```bash
SKIP_DISCOVER_UI_AUDIT=1 npm run refresh:discover-meals
```

Le mode `--full` tente de recalculer les embeddings via Ollama pour tout le catalogue. Si Ollama n’est pas joignable, le training échoue proprement vers des embeddings locaux déterministes, mais le rapport indique `embeddingMode: "hashed"`.

Le runtime ne propose jamais un produit absent du catalogue Swissdata. Le modèle ne sert qu’à classer, ranker et composer des propositions validées par le catalogue.
