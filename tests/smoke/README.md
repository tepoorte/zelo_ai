# Smoke Tests

Cette suite lance des tests reels contre l'API locale de `zelo_ai`.

Elle est faite pour verifier rapidement que les flux principaux fonctionnent encore:

- login
- vidage du panier
- ajout simple
- affichage du panier
- retrait cible
- ajout multi-produits
- messages clients plus naturels et plus longs
- gestion d'une question d'options
- build meal avec plusieurs recettes
- retrait d'un produit dont le nom contient `panier`

## Important

Ces tests utilisent le **vrai panier** du compte connecte.

La suite:

1. se connecte avec un compte reel
2. vide le panier au debut
3. execute plusieurs actions panier
4. vide a nouveau le panier a la fin

Ne la lance pas si ce compte est en train d'etre utilise pour une vraie commande.

## Variables d'environnement

Il faut fournir:

```bash
export ZELO_TEST_USERNAME="login-example-002@example.invalid"
export ZELO_TEST_PASSWORD="votre_mot_de_passe"
```

Optionnel:

```bash
export ZELO_TEST_BASE_URL="http://127.0.0.1:3041"
export ZELO_TEST_USER_REF="smoke-manuel"
```

Par defaut:

- `ZELO_TEST_BASE_URL=http://127.0.0.1:3041`
- `ZELO_TEST_USER_REF=smoke-<timestamp>`

## Lancer la suite

```bash
npm run test:smoke
```

## Ce qui est verifie

La suite attend des reponses et verifie aussi l'etat du panier:

1. `vide mon panier`
2. `ajoute 1 lard de begnins a mon panier`
3. `montre-moi mon panier`
4. `supprime 1 lard du begnins de mon panier`
5. longue commande multi-produits
6. reponse `aucune` pour les options
7. `supprime les 8 Oeuf Bio a la piece`
8. commande libre courte avec brochet et gruyere d'alpage
9. commande multi-lignes avec pains, perche et yaourts
10. commande libre avec lait et yaourt stracciatella
11. commande longue mixte avec plusieurs produits et quantites
12. build meal `hot dog`
13. build meal `carbonara`
14. build meal `hamburger`
15. build meal `spaghetti bolognese`
16. build meal `maccheroni carbonara`
17. build meal `filet de perche et pomme de terre`
18. `ajoute 1 panier budget 50 a mon panier`
19. `supprime 1 panier budget 50`
20. `vide mon panier`

## Etendre la suite

Le fichier a modifier est:

- [`run.ts`](/Users/samueltepoorten/Desktop/zelo_dev/zelo_ai/tests/smoke/run.ts)

Il suffit d'ajouter un nouveau `Step` dans le tableau `STEPS`:

- `text`: le message a envoyer
- `hint`: le frontendIntentHint optionnel
- `expectMessageIncludes`: morceaux de texte attendus dans la reponse
- `basketExpectation`: etat attendu du panier
- `autoReplyNoOptions`: repond automatiquement `aucune` tant que l'API pose une question d'options
- `maxAutoNoOptionsReplies`: limite de securite pour le nombre de reponses automatiques `aucune`

## Sortie

La suite affiche:

- `INFO` pour chaque etape envoyee
- `PASS` quand l'etape est validee
- `FAIL` quand une verification ne passe pas

La suite continue jusqu'a la fin meme si certaines etapes echouent, puis affiche un recapitulatif final des erreurs.
