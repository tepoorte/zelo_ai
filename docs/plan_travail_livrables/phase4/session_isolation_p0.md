# Correctif P0 - Isolation des sessions client

## Constat

Une revue des logs de production et du code a mis en évidence un défaut
d'isolation : l'interface web utilisait un identifiant fixe `local-dev` pour
les appels de login, panier, chat et commande. Le backend stockait ensuite le
token Swissdata en mémoire sous cette même clé.

Conséquence : si deux utilisateurs se connectaient depuis l'assistant web, le
dernier login pouvait remplacer le token associé à `local-dev`. Une commande
validée ensuite pouvait donc utiliser le mauvais compte Swissdata.

## Mesure de mitigation

Le correctif introduit une session serveur opaque par login web :

- le navigateur ne choisit plus le principal utilisateur;
- `/ai/login` crée une session serveur propre à l'utilisateur authentifié;
- la session est transmise par cookie `HttpOnly`, `SameSite=Lax`;
- le cookie est `Secure` sur HTTPS/production et reste compatible avec
  `localhost` pour les tests locaux;
- les routes panier/chat/commande récupèrent le compte depuis la session;
- les paramètres `userRef` venant du frontend ne pilotent plus les mutations;
- une requête sans session valide reçoit `401`;
- logout supprime le token Swissdata et la session serveur;
- les logs panier sont réduits pour éviter l'exposition d'adresses, tokens ou
  paniers complets.

Les identifiants techniques de session sont aléatoires et stockés côté serveur
avec un préfixe interne `web:`. Les logs n'affichent qu'une empreinte courte du
principal, jamais le token, le cookie, le mot de passe ou le contenu complet du
panier.

## Validation locale réalisée

Validation réalisée le 16 juin 2026 avec deux comptes locaux distincts :

- compte A : panier test avec `Beurre frais`;
- compte B : panier test avec `Pain Balance` et `Oeuf Bio à la pièce`;
- vérification que le compte B ne voyait pas le produit du compte A;
- vérification que le compte A ne voyait pas les produits du compte B;
- requête volontairement forgée avec `userRef="local-dev"` envoyée avec le
  cookie du compte A : le backend a ignoré ce `userRef` et conservé la session
  serveur du compte A;
- commande passée avec succès sur le compte B;
- panier test du compte A vidé ensuite.

Commandes de validation exécutées :

```text
npm run test:session-isolation
npm run test:agent-formatting
npm run build
./dockerRes_login.sh
test local multi-account via API HTTP locale
```

Résultat : les tests automatisés et le scénario multi-compte local sont passés.

## Extension WhatsApp passwordless

Le flux WhatsApp ne peut pas utiliser les cookies `HttpOnly` du web. Il a donc
été isolé avec un mécanisme dédié :

- l'identité technique WhatsApp reste `wa:<numero_normalise>`;
- au premier message, Zelo AI cherche le client correspondant via l'API
  Swissdata admin du shop, jamais via un accès direct Mongo runtime;
- si un customer unique est trouvé et lié à un user avec email, Zelo AI envoie
  un OTP à 6 chiffres par email;
- l'OTP est stocké côté Zelo AI uniquement sous forme de hash salé, avec TTL,
  cooldown et nombre de tentatives limité;
- après validation du code, Zelo AI crée une session serveur WhatsApp
  customer-scoped contenant `customerId`, `userId` et email de notification;
- `add_items`, `show_cart`, `clear_cart`, `discover_meals` et `exec_cart`
  utilisent cette session `wa:<numero>` et ne réutilisent jamais un compte
  global;
- `logout` / `déconnexion` supprime la session WhatsApp;
- les anciennes routes de mapping `/integrations/meta/whatsapp/link` sont
  admin-only en développement et désactivées en production.

Différence importante avec le web : Swissdata ne fournit pas d'endpoint public
permettant de créer un vrai token client uniquement depuis le numéro de
téléphone. Le flux WhatsApp applique donc un adapter "customer-scoped" côté
Zelo AI : après OTP email, les opérations panier passent par les routes
Swissdata autorisées pour le shop, toujours filtrées sur le `customerId`
vérifié. Cette décision évite de modifier `swissdata-api` tout en supprimant le
risque d'un token partagé entre clients.

Mesures de sécurité spécifiques :

- aucune demande de mot de passe sur WhatsApp;
- pas de log du code OTP, token, mot de passe, email complet, téléphone complet
  ou panier complet;
- réponse générique si le numéro est inconnu, ambigu ou mal configuré, afin de
  réduire l'énumération de comptes;
- SMTP configuré via variables d'environnement;
- compte Swissdata de service recommandé en production avec permissions
  minimales : lecture customers/users, lecture/écriture orders nécessaires, pas
  de write sur users/customers/products.

## Validation attendue

Le scénario de validation multi-utilisateur à reproduire avant un deploy
critique est :

1. ouvrir une session avec un premier compte Zélo;
2. ajouter un produit au panier;
3. ouvrir une seconde session navigateur avec un autre compte;
4. vérifier que le panier est distinct;
5. ajouter un autre produit dans la seconde session;
6. revenir à la première session et vérifier l'absence de contamination;
7. passer commande uniquement après validation explicite du compte de test.

Ce point complète la Phase 4 sécurité : il supprime une dépendance à une
identité client contrôlable et rapproche le projet d'une architecture
multi-utilisateur conforme aux bonnes pratiques nLPD/GDPR.
