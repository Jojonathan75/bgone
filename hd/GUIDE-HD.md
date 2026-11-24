# Mettre en route le HD payant de Poppix

Le code est prêt. Tant que les quatre réglages ci-dessous n'existent pas, le site
continue d'afficher « HD bientôt » : rien ne casse.

On commence **en mode test**, sur l'adresse d'aperçu de la branche, sans vrai argent.
Ne colle jamais une clé dans un chat ou un e-mail. Elle se colle uniquement dans Cloudflare.

## 1. Stripe (paiement)
1. Crée ton compte sur stripe.com. Pour encaisser pour de vrai, Stripe demandera ton SIRET, une pièce d'identité et ton IBAN. Pour le test, ce n'est pas nécessaire.
2. En haut du tableau de bord, active le **mode test** (« Test mode » ou « Sandbox »).
3. Va dans **Développeurs → Clés API** et copie la **clé secrète** qui commence par `sk_test_`.

## 2. Replicate (agrandissement IA)
1. Crée ton compte sur replicate.com (connexion avec GitHub possible).
2. Ajoute une carte bancaire dans **Billing**. Une image coûte moins d'un centime.
3. Va dans **Account → API tokens**, crée un jeton et copie-le (il commence par `r8_`).

## 3. Base de données des crédits (Cloudflare D1)
1. Dans Cloudflare, va dans **Storage & Databases → D1 SQL Database → Create**, et nomme la base `poppix-hd`.
2. Ouvre la base, onglet **Console**. Colle tout le contenu du fichier `hd/schema.sql`, puis clique sur **Execute**.
3. Va dans **Workers & Pages → poppix → Settings → Bindings → Add → D1 database**.
   Nom de la variable : `HD_DB`. Base : `poppix-hd`. Fais-le pour **Preview** et pour **Production**.

## 4. Les secrets dans Cloudflare
**Workers & Pages → poppix → Settings → Variables and Secrets → Add.** Choisis le type **Secret** à chaque fois.
Pour le test, choisis l'environnement **Preview** uniquement.

| Nom | Valeur |
|---|---|
| `STRIPE_SECRET_KEY` | ta clé `sk_test_…` |
| `REPLICATE_API_TOKEN` | ton jeton `r8_…` |
| `CODE_SECRET` | une longue phrase inventée, par exemple 6 mots au hasard. Ne la change plus ensuite. |

Ensuite, relance le dernier déploiement de la branche : **Deployments → … → Retry deployment**.

## 5. Tester
Ouvre l'adresse d'aperçu de la branche (dans Deployments, elle ressemble à `feature-hd-payant.poppix.pages.dev`).
Un bandeau jaune « MODE TEST » doit apparaître dans la fenêtre HD.
Pour payer, utilise la carte **4242 4242 4242 4242**, une date future et n'importe quel code à 3 chiffres.

## 6. Passer en vrai (seulement quand tout marche)
1. Active ton compte Stripe (SIRET, IBAN), puis copie la clé secrète **live** (`sk_live_…`).
2. Mets les mêmes trois secrets dans l'environnement **Production**, avec la clé live.
3. Fusionne la branche dans `main`. Le site se met à jour tout seul.

## Bon à savoir
- Packs : 10 crédits pour 2,99 €, 50 pour 9,99 €, 200 pour 24,99 €. Ils se changent en haut de `functions/api/hd/[[route]].js`.
- Si un agrandissement échoue, le crédit est rendu automatiquement.
- Un visiteur qui a perdu son code peut te le demander : retrouve son achat dans Stripe (date, montant), puis cherche le code dans la console D1 :
  `SELECT code FROM purchases WHERE session_id = 'cs_…';`
- Ajouter des crédits à la main (geste commercial) :
  `UPDATE codes SET credits = credits + 5 WHERE code = 'XXXX-XXXX-XXXX';`
