# Infomaniak AI option

Le collègue a proposé une location de service Infomaniak AI pour la production.

## État du code actuel

Aujourd'hui, `zelo_ai` parle directement à Ollama :

- chat : `POST ${OLLAMA_BASE_URL}/api/chat`
- embeddings legacy : `POST ${OLLAMA_BASE_URL}/api/embeddings`
- embeddings modernes : `POST ${OLLAMA_BASE_URL}/api/embed`

Cela se trouve dans :

- `src/ai/services/ollama-client.ts`

Donc `OLLAMA_BASE_URL` doit pointer vers un service compatible Ollama.

## Conséquence

Si Infomaniak fournit une API compatible Ollama, il suffit de définir :

```env
OLLAMA_BASE_URL=<URL_INFOMANIAK_COMPATIBLE_OLLAMA>
OLLAMA_MODEL=<MODEL_CHAT>
OLLAMA_PLANNER_MODEL=<MODEL_PLANNER>
OLLAMA_EMBEDDING_MODEL=<MODEL_EMBEDDING>
```

Si Infomaniak fournit une API compatible OpenAI mais pas Ollama, il faudra ajouter un adapter avant deploy :

- `ollamaChat(...)` devra router vers une fonction OpenAI-compatible.
- `ollamaEmbed(...)` devra router vers l'endpoint embeddings compatible.
- `AI_PROVIDER` devra enfin être respecté dans le code.

## Recommandation pratique

Pour le premier deploy production, éviter de changer deux dimensions en même temps.

Chemin le plus sûr :

1. Déployer avec Ollama compatible, parce que le code actuel est déjà validé avec cette API.
2. Vérifier login, panier, build meal, feedback, commande.
3. Ensuite seulement, ajouter l'adapter Infomaniak/OpenAI-compatible si l'équipe veut externaliser l'inférence.

