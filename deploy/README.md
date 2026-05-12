# Deploy production Zelo AI

Objectif : publier `zelo_ai` sur l'infrastructure principale Zelo, derrière le Traefik de production, avec l'API Swissdata réelle et en conservant tous les fichiers `.cache`.

Ce dossier est une documentation opérationnelle. Il ne lance aucun déploiement tout seul.

## Ce qui existe déjà

- Serveur production Zelo : `195.15.215.113`, SSH port `5222`.
- Traefik production déjà utilisé par `api.zelo-epicerie.ch`, `app.zelo-epicerie.ch` et `config.zelo-epicerie.ch`.
- Réseau Traefik production observé dans les fichiers Zelo : `traefik-net`.
- Resolver TLS production observé dans `zelo.client/docs/deployment/*` : `p5`.
- `zelo_ai/docker-compose.yml` publie un service sur Traefik avec `AI_HOST`.
- `zelo_ai/Dockerfile` est déjà un Dockerfile production multi-stage.
- `zelo_ai/.cache` contient le training, les feedbacks, les recettes utilisateur et des caches utiles au build meal.

## Décision d'architecture

Chemin conseillé pour un premier vrai deploy production :

1. Construire et pousser une image Docker `hub.mintello.com/ai-zelo:<version>`.
2. Déployer cette image sur le serveur production, derrière Traefik.
3. Monter un volume persistant `.cache` sur `/app/.cache`.
4. Utiliser `https://api.zelo-epicerie.ch` comme backend Swissdata.
5. Garder Ollama séparé du conteneur web.

Deux options sont possibles pour l'IA :

- Option A, rapide et compatible avec le code actuel : lancer Ollama sur le serveur, dans le même compose ou sur le même host.
- Option B, service Infomaniak AI : possible, mais pas plug-and-play tant que le code appelle directement l'API Ollama (`/api/chat`, `/api/embeddings`, `/api/embed`). Il faut soit une URL compatible Ollama, soit ajouter un adapter OpenAI-compatible avant.

## Domaine

Le compose accepte `AI_HOST`. Pour la production principale, utiliser un sous-domaine qui pointe vers `195.15.215.113` :

```env
AI_HOST=assistant.zelo-epicerie.ch
```

`ai.zelo-epicerie.ch` ne doit pas être utilisé tant que son DNS pointe vers un autre serveur. Si l'équipe veut un autre nom client, changer seulement `AI_HOST` et créer le DNS correspondant avant le deploy. Exemples possibles :

- `assistant.zelo-epicerie.ch`
- `commande.zelo-epicerie.ch`
- `aide.zelo-epicerie.ch`

Ne pas réutiliser `app.zelo-epicerie.ch`, car il est déjà servi par `zelo.client`.

## Points critiques avant deploy

- Ne pas perdre `.cache`.
- Ne pas utiliser `CERTRESOLVER=mint-le` en prod si Traefik production utilise `p5`.
- Ne pas oublier `OLLAMA_EMBEDDING_MODEL=nomic-embed-text` ou au minimum installer ce modèle dans Ollama, car build meal utilise les embeddings.
- Ne pas lancer la smoke suite sur un vrai compte client sans vider/contrôler le panier.
- Les sessions Swissdata sont en RAM dans `src/swissdata/session.ts` et `src/swissdata/auth.ts`; un restart déconnecte les utilisateurs.
- Les deux HTML utilisent encore `USER_REF = "local-dev"`; pour un vrai multi-user public, c'est à corriger avant ouverture large.

## Préparation locale

Depuis le Mac :

```bash
cd /Users/samueltepoorten/Desktop/zelo_dev/zelo_ai
git status --short
npm run build
npm run test:delivery
npm run test:build-meal-family
npm run test:build-meal-matching
```

Ou avec le script :

```bash
./deploy/01-local-preflight.sh
```

Smoke locale optionnelle, uniquement avec un compte de test :

```bash
ZELO_TEST_BASE_URL=http://127.0.0.1:3041 \
ZELO_TEST_USER_REF=prod-preflight-$(date +%s) \
ZELO_TEST_USERNAME="TON_EMAIL_TEST" \
ZELO_TEST_PASSWORD="TON_PASSWORD_TEST" \
npm run test:smoke
```

## Sauvegarde locale de `.cache`

Créer une archive avant tout deploy :

```bash
cd /Users/samueltepoorten/Desktop/zelo_dev/zelo_ai
tar -czf /tmp/zelo_ai_cache_$(date +%Y%m%d_%H%M%S).tgz .cache
```

Copier l'archive vers le serveur :

```bash
scp -P 5222 /tmp/zelo_ai_cache_YYYYMMDD_HHMMSS.tgz ubuntu@195.15.215.113:~/
```

## Push Git

Le serveur doit pouvoir retrouver exactement la même version que le Mac.

```bash
cd /Users/samueltepoorten/Desktop/zelo_dev/zelo_ai
git status --short
git ls-files | grep -E '(^|/)\.DS_Store$' | while read file; do git rm --cached --ignore-unmatch "$file"; done
git add .
git diff --cached --stat
git commit -m "Prepare production Zelo AI deploy"
git push origin main
```

À faire seulement quand le diff est validé. Le `.gitignore` protège `.env`, `node_modules`, `dist`, les `.zip`, les archives et les dossiers temporaires. Ne pas ignorer `.cache`, car elle contient le learning.

Ou avec le script :

```bash
./deploy/02-commit-and-push.sh "Prepare production Zelo AI deploy"
```

Ce script utilise `git add .`, mais enlève d'abord les `.DS_Store` déjà trackés de l'index Git sans supprimer les fichiers locaux.

## Build et push Docker

Le script `docker-build.sh` build/tag déjà l'image, mais les `docker push` y sont actuellement commentés. Pour éviter toute ambiguïté, utiliser des commandes explicites :

```bash
cd /Users/samueltepoorten/Desktop/zelo_dev/zelo_ai
docker login hub.mintello.com

export DOCKER_IMAGE=hub.mintello.com/ai-zelo
export VERSION=1.0.0

docker build --no-cache --platform=linux/amd64 -t "$DOCKER_IMAGE:$VERSION" -t "$DOCKER_IMAGE:latest" .
docker push "$DOCKER_IMAGE:$VERSION"
docker push "$DOCKER_IMAGE:latest"
```

Adapter `VERSION` à chaque release.

Ou avec le script complet build + serveur :

```bash
VERSION=1.0.0 ./deploy/03-build-push-and-server-deploy.sh
```

Ce script utilise l'archive `.cache` créée par `01-local-preflight.sh`, pousse l'image Docker, copie les fichiers runtime au serveur dans `/home/ubuntu/zelo-ai`, sauvegarde l'ancien `.env` et l'ancien `.cache`, puis relance le compose. Il ne clone pas le code source sur le serveur.

Par défaut, si une `.cache` existe déjà sur le serveur, elle reste active et n'est pas remplacée par la `.cache` locale. Pour un premier déploiement sans `.cache` serveur, l'archive locale est restaurée automatiquement. Pour forcer volontairement le remplacement de la `.cache` serveur, lancer explicitement :

```bash
REPLACE_SERVER_CACHE=1 VERSION=1.0.0 ./deploy/03-build-push-and-server-deploy.sh
```

## Préparation serveur

Connexion :

```bash
ssh -p 5222 ubuntu@195.15.215.113
```

Vérifier Docker, Traefik et le réseau :

```bash
docker ps
docker network inspect traefik-net
docker compose version
```

Préparer le dossier runtime :

```bash
mkdir -p ~/zelo-ai
```

## Restaurer `.cache` sur le serveur

Avant de remplacer quoi que ce soit, sauvegarder ce qui existe déjà :

```bash
cd ~/zelo-ai
mkdir -p ~/zelo-ai-backups

if [ -d .cache ]; then
  tar -czf ~/zelo-ai-backups/zelo_ai_cache_before_$(date +%Y%m%d_%H%M%S).tgz .cache
fi
```

Restaurer l'archive copiée depuis le Mac :

```bash
cd ~/zelo-ai
tar -xzf ~/zelo_ai_cache_YYYYMMDD_HHMMSS.tgz
```

Contrôler :

```bash
find .cache -maxdepth 1 -type f -name '*.json' | sort
du -sh .cache
```

Important : ne pas faire de `rm -rf .cache` en production. Si le serveur a déjà appris des corrections, fusionner ou sauvegarder avant.

## Fichier `.env` production

Créer `.env` sur le serveur depuis le template :

```bash
cd ~/zelo-ai
cp .env.template .env
nano .env
```

Si un `.env` existe déjà sur le serveur, il ne doit pas rester tel quel par accident : il peut contenir une ancienne version, un mauvais `AI_HOST`, un mauvais resolver TLS ou une mauvaise image. Le script `03-build-push-and-server-deploy.sh` le sauvegarde d'abord dans `~/zelo-ai-backups/zelo_ai_env_before_YYYYMMDD_HHMMSS.env`, puis remplace `.env` avec le template copié et injecte `VERSION` et `AI_HOST`.

Valeurs importantes :

```env
NODE_ENV=production
PORT=3041
AI_HOST=assistant.zelo-epicerie.ch
AI_PORT=3041

AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3.2:1b
OLLAMA_PLANNER_MODEL=llama3.2:1b
OLLAMA_EMBEDDING_MODEL=nomic-embed-text

SWISSDATA_BASE_URL=https://api.zelo-epicerie.ch
SWISSDATA_API_KEY=PUBLICDEMO01
SWISSDATA_SHOP_ID=000000000000000000000001
SWISSDATA_COUNTRY=CHE

PROXYNET=traefik-net
CERTRESOLVER=p5

DOCKERREGISTRY=hub.mintello.com
IMAGENAME=ai-zelo
VERSION=<VERSION_PUSHED>
```

## Déployer avec image Docker

Si Ollama est déjà disponible ailleurs :

```bash
cd ~/zelo-ai
docker login hub.mintello.com
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d
docker compose --env-file .env -f docker-compose.yml ps
```

Si Ollama doit tourner sur le même serveur, utiliser le compose proposé dans ce dossier :

```bash
cd ~/zelo-ai
docker compose --env-file .env -f docker-compose.yml up -d
docker exec zelo-ai-ollama ollama pull "$OLLAMA_MODEL"
docker exec zelo-ai-ollama ollama pull "$OLLAMA_PLANNER_MODEL"
docker exec zelo-ai-ollama ollama pull "$OLLAMA_EMBEDDING_MODEL"
docker compose --env-file .env -f docker-compose.yml ps
```

## Vérifications post-deploy

Health :

```bash
curl -fsS https://assistant.zelo-epicerie.ch/health
```

Logs :

```bash
cd ~/zelo-ai
docker compose --env-file .env -f docker-compose.yml logs --tail=200 zelo_ai
```

Si compose avec Ollama :

```bash
docker logs --tail=200 zelo-ai-ollama
docker exec zelo-ai-ollama ollama list
```

Tests manuels dans l'UI :

1. Ouvrir `https://assistant.zelo-epicerie.ch`.
2. Se connecter avec un compte test.
3. Tester `montre mon panier`.
4. Tester `ajoute 1 baguette`.
5. Vérifier que la livraison estimée est future.
6. Tester `vide mon panier` uniquement sur compte test.
7. Tester une recette validée : `de quoi faire une carbonara`.
8. Vérifier que le panneau build meal/feedback fonctionne en vue complète.

Smoke prod possible mais risquée :

```bash
ZELO_TEST_BASE_URL=https://assistant.zelo-epicerie.ch \
ZELO_TEST_USER_REF=prod-smoke-$(date +%s) \
ZELO_TEST_USERNAME="TON_EMAIL_TEST" \
ZELO_TEST_PASSWORD="TON_PASSWORD_TEST" \
npm run test:smoke
```

Ne pas lancer avec un vrai panier client.

## Rollback

Rollback image :

```bash
cd ~/zelo-ai
nano .env
# remettre VERSION=<ancienne_version>
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d
```

Rollback cache :

```bash
cd ~/zelo-ai
tar -czf ~/zelo-ai-backups/zelo_ai_cache_bad_$(date +%Y%m%d_%H%M%S).tgz .cache
tar -xzf ~/zelo-ai-backups/zelo_ai_cache_before_YYYYMMDD_HHMMSS.tgz
docker compose --env-file .env -f docker-compose.yml restart zelo_ai
```

## CI/CD plus tard

Le collègue a raison : une pipeline CI/CD est possible.

Pipeline minimale recommandée :

1. Sur push `main`, lancer `npm ci`, `npm run build`, tests unitaires.
2. Build Docker `linux/amd64`.
3. Push `hub.mintello.com/ai-zelo:<sha>` et `latest`.
4. Sur serveur, pull image et `docker compose up -d`.
5. Ne jamais écraser `.cache`; la pipeline ne doit pas contenir de commande destructive sur ce dossier.

À ajouter avant CI/CD : secrets registry, accès Git, accès serveur, stratégie `.cache` et rollback automatique.

## Sources vérifiées

- `zelo_ai/Dockerfile`
- `zelo_ai/docker-compose.yml`
- `zelo_ai/docker-build.sh`
- `zelo_ai/.env.sample`
- `zelo_ai/src/config/env.ts`
- `zelo_ai/src/server.ts`
- `zelo_ai/src/swissdata/*`
- `zelo_ai/src/ai/build-meal/*`
- `zelo.client/docs/SERVER.md`
- `zelo.client/docs/deployment/zelo-prod/*`
- `zelo.client/docs/deployment/zelo-app/*`
- `zelo.client/docs/deployment/proxy/*`
- `swissdata-api/Dockerfile`
- `swissdata-api/app/server.ts`
- Infomaniak AI Services : `https://www.infomaniak.com/en/hosting/ai-services/open-source-models`
