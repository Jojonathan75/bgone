# Poppix : site de détourage d'images

Site **100 % statique** : le détourage IA tourne dans le navigateur du visiteur. Aucun serveur, aucune base de données, aucun coût de calcul.

## Contenu
- `site/` : **le dossier à mettre en ligne** (c'est tout le site).
  - `index.html` : page d'accueil + éditeur
  - `assets/app.js` : l'éditeur (pinceaux, fonds, amélioration, export)
  - `assets/worker.js` : moteur de détourage (généré, ne pas modifier à la main)
  - `models/` : modèles IA (ISNet) compressés et découpés en morceaux de 4 Mo
  - `ort/` : moteur ONNX Runtime (WebAssembly)
  - `_headers` : réglages Cloudflare Pages (accélération multi-cœur, cache)
  - `.htaccess` : mêmes réglages pour un hébergement Apache (Hostinger)
  - pages légales à compléter
- `src/worker.js` : source du moteur
- `tools/` : scripts de construction et serveur de test local

## Outils de compression (images et PDF)
- Pages : `site/compress-image/` et `site/compress-pdf/` (et `site/<langue>/compress-…/`), générées par `node tools/build-i18n.mjs` à partir de `src/tools/*.html` et des textes `src/i18n/tools/<langue>.json`.
- Interface : `site/assets/compress/ui.js` et `tools.css` (écrits à la main).
- Moteurs : `site/assets/compress/image-worker.js` et `pdf-worker.js` sont **générés** depuis `src/compress/` par `npm install` puis `node tools/build-compress.mjs`, qui copie aussi les fichiers WebAssembly dans `site/vendor/`.
- Images : MozJPEG, WebP, AVIF (jSquash, Apache 2.0), OxiPNG, UPNG.js. PDF : Ghostscript en WebAssembly (AGPL, ~15 Mo, téléchargé seulement sur la page PDF).
- Tout tourne dans le navigateur, aucun fichier n'est envoyé.

## Tester sur son ordinateur
Il faut Node.js. Dans ce dossier :
```
node tools/serve.mjs
```
puis ouvrir http://localhost:8080. (Ouvrir `index.html` en double-clic ne marche pas : le moteur IA a besoin d'un vrai serveur.)

## Mise en ligne (Cloudflare Pages, gratuit)
Le projet Cloudflare Pages est relié au dépôt GitHub : chaque envoi sur la branche `main` met le site à jour.
Réglages : « Framework preset » None, « Build command » vide, « Build output directory » `site`.

## Reconstruire le moteur (seulement si on change de version)
```
npm install
npm run build                                   # moteur + pages de toutes les langues
pip install onnx onnxruntime numpy
python tools/build-models.py <dossier des .onnx>  # modèles (voir l'en-tête du script)
```

## Langues
- Anglais à la racine (`site/index.html`), les autres langues dans `site/<code>/` : es, fr, de, pt, it, nl, ar (de droite à gauche), hi, zh, ja, ko, ru, tr, id.
- Les textes sont dans `src/i18n/<code>.json`, la page modèle dans `src/template.html`.
- Après toute modification de texte : `node tools/build-i18n.mjs` (régénère toutes les pages, le sitemap et robots.txt).
- Ajouter une langue : copier `src/i18n/en.json` en `src/i18n/<code>.json`, traduire, ajouter le code dans `ORDER` en haut de `tools/build-i18n.mjs`, relancer.
- Première visite sur la racine : le visiteur est envoyé automatiquement vers sa langue (selon son navigateur). Son choix dans le menu est mémorisé.

## Changer le nom et l'adresse du site
En haut de `tools/build-i18n.mjs` : `BRAND` (nom) et `SITE_URL` (adresse finale, nécessaire pour Google). Puis `node tools/build-i18n.mjs`.

## Licences
Le moteur (ONNX Runtime, MIT) et le modèle (ISNet, Apache-2.0) sont sous licences permissives : aucune obligation de publier le code.
Le fichier `LICENSE` (AGPL v3) concerne seulement le code du site lui-même ; son auteur peut le garder ou en changer.
