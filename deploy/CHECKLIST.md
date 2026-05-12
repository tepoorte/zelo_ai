# Production deploy checklist

## Avant

- [ ] Le diff local est relu.
- [ ] `npm run build` passe.
- [ ] Les tests build meal passent.
- [ ] La smoke locale a été lancée si nécessaire avec un compte test.
- [ ] `.cache` est archivé localement.
- [ ] `.cache` est copié sur le serveur ou déjà présent et sauvegardé.
- [ ] Les changements sont commit/push sur `main`.
- [ ] L'image Docker est poussée sur `hub.mintello.com/ai-zelo:<version>`.
- [ ] Le DNS du domaine choisi pointe vers le serveur production.
- [ ] `docker network inspect traefik-net` fonctionne sur le serveur.
- [ ] L'auth Docker registry existe sur le serveur.
- [ ] Le resolver Traefik utilisé est `p5`.
- [ ] Si une `.cache` serveur existe déjà, décider explicitement si elle doit rester active ou être remplacée avec `REPLACE_SERVER_CACHE=1`.

## Pendant

- [ ] Connexion serveur SSH port `5222`.
- [ ] Backup `.env`, `docker-compose.yml` et `.cache` serveur.
- [ ] Runtime copié dans `/home/ubuntu/zelo-ai`.
- [ ] `.env` production rendu depuis `.env.template`.
- [ ] `docker compose pull` exécuté par le script.
- [ ] `docker compose up -d` exécuté par le script.
- [ ] Si Ollama local serveur : modèles `OLLAMA_MODEL`, `OLLAMA_PLANNER_MODEL`, `OLLAMA_EMBEDDING_MODEL` installés.

## Après

- [ ] `curl -fsS https://AI_HOST/health` répond.
- [ ] Les logs `zelo_ai` ne montrent pas d'erreur.
- [ ] L'UI charge.
- [ ] Login compte test OK.
- [ ] `montre mon panier` OK.
- [ ] `ajoute 1 baguette` OK.
- [ ] Livraison estimée future OK.
- [ ] `de quoi faire une carbonara` OK.
- [ ] Feedback intention/build meal visible en vue complète.
- [ ] Panier test vidé.

## Rollback

- [ ] Ancienne version image connue.
- [ ] Archive `.cache` précédente disponible.
- [ ] Commandes rollback prêtes dans `deploy/README.md`.
