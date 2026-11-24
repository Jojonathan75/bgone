# Poppix : site de détourage d'images

Site **100 % statique** : le détourage IA tourne dans le navigateur du visiteur. Aucun serveur, aucune base de données, aucun coût de calcul.

## Contenu
- `site/` : **le dossier à mettre en ligne** (c'est tout le site).
  - `index.html` : page d'accueil + éditeur
  - `assets/app.js` : l'éditeur (pinceaux, fonds, amélioration, export)
  - `assets/worker.js` : moteur de détourage (généré, ne pas modifier à la main)
  - `bgdata/` : modèle IA + moteur ONNX découpés en morceaux de 4 Mo (~160 Mo)
  - `.htaccess` : réglages Hostinger (cache du modèle, accélération multi-cœur, HTTPS)
  - pages légales à compléter
- `src/worker.js` : source du moteur
- `tools/` : scripts de construction et serveur de test local

## Tester sur son ordinateur
Il faut Node.js. Dans ce dossier :
```
node tools/serve.mjs
```
puis ouvrir http://localhost:8080. (Ouvrir `index.html` en double-clic ne marche pas : le moteur IA a besoin d'un vrai serveur.)

## Mettre en ligne chez Hostinger
1. Prendre un hébergement web (pas besoin de VPS).
2. Gestionnaire de fichiers (ou FTP) : envoyer **le contenu** du dossier `site/` dans `public_html/`, y compris le fichier caché `.htaccess`.
3. Activer le certificat SSL (gratuit chez Hostinger).

## Reconstruire le moteur (seulement si on change de version)
```
npm install
npx esbuild src/worker.js --bundle --format=esm --minify --outfile=site/assets/worker.js
node tools/build-resources.mjs <dossier du paquet @imgly/background-removal-data décompressé>
```

## Langues
- Anglais à la racine (`site/index.html`), les autres langues dans `site/<code>/` : es, fr, de, pt, it, nl, ar (de droite à gauche), hi, zh, ja, ko, ru, tr, id.
- Les textes sont dans `src/i18n/<code>.json`, la page modèle dans `src/template.html`.
- Après toute modification de texte : `node tools/build-i18n.mjs` (régénère toutes les pages, le sitemap et robots.txt).
- Ajouter une langue : copier `src/i18n/en.json` en `src/i18n/<code>.json`, traduire, ajouter le code dans `ORDER` en haut de `tools/build-i18n.mjs`, relancer.
- Première visite sur la racine : le visiteur est envoyé automatiquement vers sa langue (selon son navigateur). Son choix dans le menu est mémorisé.

## Changer le nom et l'adresse du site
En haut de `tools/build-i18n.mjs` : `BRAND` (nom) et `SITE_URL` (adresse finale, nécessaire pour Google). Puis `node tools/build-i18n.mjs`.

## Licence et code source (AGPL v3)
Le moteur de détourage est sous licence AGPL v3, donc ce site l'est aussi (fichier `LICENSE`). Concrètement : le code doit être public, et le site doit indiquer où le trouver.
1. Créer un compte sur https://github.com (gratuit).
2. Créer un dépôt **public** vide nommé `bgone` (bouton « New repository », sans README ni licence).
3. Y envoyer ce dossier (Claude peut le faire une fois le dépôt créé et GitHub connecté).
4. Mettre l'adresse du dépôt dans `SOURCE_URL` en haut de `tools/build-i18n.mjs`, puis `node tools/build-i18n.mjs`. Le lien apparaît dans la page « Licenses & source code », accessible depuis le pied de page de toutes les langues.
