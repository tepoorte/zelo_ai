# Cache production policy

`zelo_ai` utilise `.cache` comme stockage runtime local. En production, ce dossier doit être traité comme de la donnée applicative, pas comme un cache jetable.

## Fichiers importants

- `build-meal-feedback-ledger.json` : corrections ingrédient -> produit, produits bannis.
- `build-meal-learning-inbox.json` : recettes inconnues ou demandes à apprendre.
- `build-meal-recipe-examples.json` : exemples confirmés/refusés pour reconnaître les recettes.
- `build-meal-recipe-memory.json` : index mémoire build meal, potentiellement avec embeddings.
- `build-meal-training.runtime*.json` : training build meal fusionné par contexte/utilisateur/test.
- `build-meal-user-recipes.json` : recettes créées depuis l'UI.
- `intent-feedback-ledger.json` : corrections d'intention depuis l'UI.
- `intent-training.runtime.json` : training d'intention reconstruit avec feedback.
- `catalog-local-dev.json` et `catalog-embeddings-local-dev.json` : snapshots locaux utiles au debug; ne pas les considérer comme source de vérité catalogue en prod.

## Source de vérité

- Catalogue produits : Swissdata `https://api.zelo-epicerie.ch`.
- Training seed versionné : `public/predictor/build-meal-training.json` et `public/predictor/intent-training.json`.
- Learning runtime : `.cache`.

## Règles de deploy

1. Monter `.cache` en volume sur `/app/.cache`.
2. Sauvegarder `.cache` avant chaque deploy.
3. Copier `.cache` local vers le serveur lors du premier deploy production.
4. Ne jamais faire `docker compose down -v` pour ce service.
5. Ne jamais supprimer `.cache` sans archive préalable.
6. Ajouter `.cache` aux backups serveur.

## Commandes backup

Local :

```bash
cd /Users/samueltepoorten/Desktop/zelo_dev/zelo_ai
tar -czf /tmp/zelo_ai_cache_$(date +%Y%m%d_%H%M%S).tgz .cache
```

Serveur :

```bash
cd ~/zelo-ai
mkdir -p ~/zelo-ai-backups
tar -czf ~/zelo-ai-backups/zelo_ai_cache_$(date +%Y%m%d_%H%M%S).tgz .cache
```

## Commandes inspection

```bash
cd ~/zelo-ai
find .cache -maxdepth 1 -type f -name '*.json' | sort
du -sh .cache
jq '.version // "no-version"' .cache/build-meal-user-recipes.json
jq '.events | length' .cache/intent-feedback-ledger.json
```
