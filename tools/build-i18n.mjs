// Génère une page par langue à partir de src/template.html et src/i18n/*.json.
// Usage : node tools/build-i18n.mjs
// L'anglais est à la racine (site/index.html), les autres langues dans site/<code>/index.html.
import fs from 'node:fs';
import path from 'node:path';

// ======= À RÉGLER =======
const BRAND = 'Poppix';                        // nom du site
const SITE_URL = 'https://poppix.app';  // adresse finale du site, sans / à la fin
const SOURCE_URL = 'https://github.com/Jojonathan75/bgone';                        // lien du dépôt GitHub public (obligatoire pour la licence AGPL)
// Ordre d'affichage dans le menu des langues
const ORDER = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ar', 'hi', 'zh', 'ja', 'ko', 'ru', 'tr', 'id'];
const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const HREFLANG = { zh: 'zh-Hans' };
// ========================

const tpl = fs.readFileSync('src/template.html', 'utf8');
const dicts = {};
for (const code of ORDER) dicts[code] = JSON.parse(fs.readFileSync(`src/i18n/${code}.json`, 'utf8'));
const en = dicts.en;

// Contrôle : toutes les clés anglaises doivent exister partout
for (const code of ORDER) {
  const missing = Object.keys(en).filter(k => !(k in dicts[code]));
  if (missing.length) console.warn(`[${code}] clés manquantes :`, missing.join(', '));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const urlFor = (code) => code === 'en' ? `${SITE_URL}/` : `${SITE_URL}/${code}/`;

const alternates = ORDER.map(c => `  <link rel="alternate" hreflang="${HREFLANG[c] || c}" href="${urlFor(c)}">`).join('\n')
  + `\n  <link rel="alternate" hreflang="x-default" href="${urlFor('en')}">`;

const nonEn = ORDER.filter(c => c !== 'en');
const redirect = `<script>(function(){try{var L=${JSON.stringify(nonEn)},s=localStorage.getItem('lang');if(s){if(L.indexOf(s)>-1)location.replace(s+'/');return}var p=navigator.languages||[navigator.language||''];for(var i=0;i<p.length;i++){var c=String(p[i]).slice(0,2).toLowerCase();if(c==='en')return;if(L.indexOf(c)>-1){location.replace(c+'/');return}}}catch(e){}})()</script>`;

for (const code of ORDER) {
  const d = { ...en, ...dicts[code] };
  const base = code === 'en' ? '' : '../';
  const options = ORDER.map(c => `<option value="${c}"${c === code ? ' selected' : ''}>${esc(dicts[c]._name)}</option>`).join('');
  const langselect = `<label class="lang-select"><span class="sr-only">${esc(d.lang_label)}</span><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg><select id="lang" data-base="${base}">${options}</select></label>`;
  const jsKeys = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('js_') || k.startsWith('dl_') || k.startsWith('bg_')));
  const vars = {
    lang: code, dir: RTL.has(code) ? 'rtl' : 'ltr', brand: esc(BRAND), base, site_url: SITE_URL, guides: base + (code === 'fr' ? 'fr/guides/' : 'guides/'),
    alternates, redirect: code === 'en' ? redirect : '', langselect,
    i18njson: JSON.stringify(jsKeys).replace(/</g, '\\u003c'),
  };
  const html = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (k in vars) return vars[k];
    if (k in d) return esc(d[k]);
    console.warn(`[${code}] clé inconnue dans le modèle : ${k}`);
    return k;
  });
  const out = code === 'en' ? 'site/index.html' : `site/${code}/index.html`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
}

// Plan du site pour Google
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${ORDER.map(c => `  <url><loc>${urlFor(c)}</loc>\n${ORDER.map(a => `    <xhtml:link rel="alternate" hreflang="${HREFLANG[a] || a}" href="${urlFor(a)}"/>`).join('\n')}\n  </url>`).join('\n')}
</urlset>
`;
fs.writeFileSync('site/sitemap.xml', sitemap);
fs.writeFileSync('site/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);

// ======= Pages annexes (src/pages/**.html) =======
// Chaque fichier commence par un commentaire JSON :
//   <!--{"title":"…","lang":"en","desc":"…","noindex":false,"alt":{"fr":"fr/guides/x.html"}}-->
// Le reste du fichier est le contenu de la page (sans <html>, <head>, en-tête ni pied de page).
const FOOT = {
  en: [['about.html', 'About'], ['guides/', 'Guides'], ['contact.html', 'Contact'], ['terms.html', 'Terms of use'], ['sales.html', 'Terms of sale'], ['privacy.html', 'Privacy'], ['cookies.html', 'Cookies'], ['legal.html', 'Legal notice'], ['licenses.html', 'Licenses']],
  fr: [['about.html', 'À propos'], ['fr/guides/', 'Guides'], ['contact.html', 'Contact'], ['terms.html', 'CGU'], ['sales.html', 'CGV'], ['privacy.html', 'Confidentialité'], ['cookies.html', 'Cookies'], ['legal.html', 'Mentions légales'], ['licenses.html', 'Licences']],
};
const CTA = { en: 'Remove a background', fr: 'Détourer une image' };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const pages = [];
for (const src of walk('src/pages').filter(f => f.endsWith('.html'))) {
  const rel = path.relative('src/pages', src).split(path.sep).join('/');
  const raw = fs.readFileSync(src, 'utf8');
  const m = raw.match(/^<!--(\{[\s\S]*?\})-->\s*/);
  if (!m) { console.warn('Page sans en-tête JSON :', rel); continue; }
  const meta = JSON.parse(m[1]);
  const body = raw.slice(m[0].length);
  const lang = meta.lang || 'en';
  const base = '../'.repeat(rel.split('/').length - 1);
  const urlOf = (r) => `${SITE_URL}/${r.replace(/index\.html$/, '')}`;
  const alts = meta.alt ? Object.entries({ [lang]: rel, ...meta.alt }).map(([l, r]) => `<link rel="alternate" hreflang="${l}" href="${urlOf(r)}">`).join('') : '';
  const foot = (FOOT[lang] || FOOT.en).map(([h, t]) => `<a href="${base}${h}">${esc(t)}</a>`).join('');
  const home = lang === 'fr' ? `${base}fr/` : `${base}`;
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)} · ${esc(BRAND)}</title>${meta.desc ? `<meta name="description" content="${esc(meta.desc)}">` : ''}${meta.noindex ? '<meta name="robots" content="noindex">' : ''}
<link rel="canonical" href="${urlOf(rel)}">${alts}
<link rel="icon" href="${base}favicon.ico" sizes="any"><link rel="icon" href="${base}assets/favicon-32.png" type="image/png" sizes="32x32"><link rel="apple-touch-icon" href="${base}assets/apple-touch-icon.png">
<link rel="stylesheet" href="${base}assets/styles.css"></head>
<body><header class="site-header"><a class="brand" href="${home}"><img class="brand-logo" src="${base}assets/logo-40.png" srcset="${base}assets/logo-80.png 2x" width="43" height="40" alt=""><span class="brand-name">${esc(BRAND)}</span></a><a class="btn btn-primary btn-sm page-cta" href="${home}">${esc(CTA[lang] || CTA.en)}</a></header>
<main class="legal">
${body.replace(/\{\{brand\}\}/g, esc(BRAND)).replace(/\{\{base\}\}/g, base).replace(/\{\{source\}\}/g, `<a href="${esc(SOURCE_URL)}">${esc(SOURCE_URL)}</a>`)}
</main>
<footer class="site-footer"><p>© ${new Date().getFullYear()} ${esc(BRAND)}</p><nav>${foot}</nav></footer>
</body></html>
`;
  fs.mkdirSync(path.dirname(`site/${rel}`), { recursive: true });
  fs.writeFileSync(`site/${rel}`, html);
  if (!meta.noindex) pages.push(urlOf(rel));
}
// Ajoute les pages indexables au plan du site
if (pages.length) {
  const sm = fs.readFileSync('site/sitemap.xml', 'utf8').replace('</urlset>', pages.map(u => `  <url><loc>${u}</loc></url>`).join('\n') + '\n</urlset>');
  fs.writeFileSync('site/sitemap.xml', sm);
}

// ads.txt (Google AdSense) : mettre l'identifiant d'éditeur « pub-… » une fois le compte AdSense créé
const ADSENSE_PUB = '';
fs.writeFileSync('site/ads.txt', ADSENSE_PUB
  ? `google.com, ${ADSENSE_PUB}, DIRECT, f08c47fec0942fa0\n`
  : '# À compléter : google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0\n');

console.log(`OK : ${ORDER.length} langues générées pour ${BRAND}`);

// Manifeste pour l'icône sur l'écran d'accueil des téléphones
fs.writeFileSync('site/site.webmanifest', JSON.stringify({
  name: BRAND, short_name: BRAND, start_url: '/', display: 'standalone',
  background_color: '#fffaf3', theme_color: '#ff7a1a',
  icons: [
    { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
}, null, 2) + '\n');
