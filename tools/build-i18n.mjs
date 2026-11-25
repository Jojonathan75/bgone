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
// Textes des outils de compression (src/i18n/tools/) : fusionnés avec ceux de la page principale
for (const code of ORDER) {
  const f = `src/i18n/tools/${code}.json`;
  dicts[code] = { ...dicts[code], ...(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}) };
}
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
    lang: code, dir: RTL.has(code) ? 'rtl' : 'ltr', brand: esc(BRAND), base, site_url: SITE_URL,
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

// Pages des outils (compression d'images, de PDF) : une page par outil et par langue
const TOOL_PAGES = await import('./build-tools.mjs').then(m => m.buildTools({ ORDER, RTL, HREFLANG, dicts, BRAND, SITE_URL, esc }));

// Plan du site pour Google
const sitemapGroup = (url) => ORDER.map(c => `  <url><loc>${url(c)}</loc>\n${ORDER.map(a => `    <xhtml:link rel="alternate" hreflang="${HREFLANG[a] || a}" href="${url(a)}"/>`).join('\n')}\n  </url>`).join('\n');
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${[urlFor, ...TOOL_PAGES].map(sitemapGroup).join('\n')}
</urlset>
`;
fs.writeFileSync('site/sitemap.xml', sitemap);
fs.writeFileSync('site/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);

// Les pages légales portent aussi le nom du site
for (const f of ['legal.html', 'privacy.html', 'licenses.html']) {
  const src = `src/pages/${f}`;
  if (fs.existsSync(src)) fs.writeFileSync(`site/${f}`, fs.readFileSync(src, 'utf8').replace(/\{\{brand\}\}/g, esc(BRAND)).replace(/\{\{source\}\}/g, SOURCE_URL ? `<a href="${esc(SOURCE_URL)}">${esc(SOURCE_URL)}</a>` : '<span class="todo">link coming soon</span>'));
}
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
