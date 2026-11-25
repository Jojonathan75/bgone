// Génère les pages des outils (compression d'images et de PDF) dans toutes les langues.
// Appelé automatiquement par tools/build-i18n.mjs : il n'y a rien à lancer à part.
// Anglais : site/<outil>/index.html ; autres langues : site/<code>/<outil>/index.html
import fs from 'node:fs';
import path from 'node:path';

export const TOOLS = [
  { slug: 'compress-image', tpl: 'src/tools/compress-image.html', key: 'ci', nav: 'nav_compress_img', desc: 'tool_img_d' },
  { slug: 'compress-pdf', tpl: 'src/tools/compress-pdf.html', key: 'cp', nav: 'nav_compress_pdf', desc: 'tool_pdf_d' },
];

export function buildTools({ ORDER, RTL, HREFLANG, dicts, BRAND, SITE_URL, esc }) {
  const en = dicts.en;
  const nonEn = ORDER.filter(c => c !== 'en');
  const urls = [];

  for (const tool of TOOLS) {
    const tpl = fs.readFileSync(tool.tpl, 'utf8');
    const urlFor = (code) => code === 'en' ? `${SITE_URL}/${tool.slug}/` : `${SITE_URL}/${code}/${tool.slug}/`;
    urls.push(urlFor);
    const alternates = ORDER.map(c => `  <link rel="alternate" hreflang="${HREFLANG[c] || c}" href="${urlFor(c)}">`).join('\n')
      + `\n  <link rel="alternate" hreflang="x-default" href="${urlFor('en')}">`;
    // Même logique que la page d'accueil : première visite en anglais → langue du navigateur
    const redirect = `<script>(function(){try{var L=${JSON.stringify(nonEn)},s=localStorage.getItem('lang');if(s){if(L.indexOf(s)>-1)location.replace('../'+s+'/${tool.slug}/');return}var p=navigator.languages||[navigator.language||''];for(var i=0;i<p.length;i++){var c=String(p[i]).slice(0,2).toLowerCase();if(c==='en')return;if(L.indexOf(c)>-1){location.replace('../'+c+'/${tool.slug}/');return}}}catch(e){}})()</script>`;

    for (const code of ORDER) {
      const d = { ...en, ...dicts[code] };
      const base = code === 'en' ? '../' : '../../';
      const options = ORDER.map(c => `<option value="${c}"${c === code ? ' selected' : ''}>${esc(dicts[c]._name)}</option>`).join('');
      const langselect = `<label class="lang-select"><span class="sr-only">${esc(d.lang_label)}</span><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg><select id="lang" data-base="${base}" data-slug="${tool.slug}">${options}</select></label>`;
      const link = (slug) => slug ? `../${slug}/` : '../';
      const navItems = [
        ['', d.nav_remove_bg],
        ...TOOLS.map(t => [t.slug, d[t.nav]]),
      ];
      const header = `  <header class="site-header">
    <a class="brand" href="../" aria-label="${esc(BRAND)}">
      <img class="brand-logo" src="${base}assets/logo-40.png" srcset="${base}assets/logo-80.png 2x" width="43" height="40" alt="">
      <span class="brand-name">${esc(BRAND)}</span>
    </a>
    <nav class="site-nav tool-nav" aria-label="${esc(d.foot_tools)}">
${navItems.map(([s, label]) => `      <a href="${link(s)}"${s === tool.slug ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('\n')}
    </nav>
    ${langselect}
  </header>`;
      const moretools = `    <section class="more-tools">
      <h2 class="section-title">${esc(d.tools_title)}</h2>
      <div class="tool-links">
        <a class="tool-link" href="../"><strong>${esc(d.nav_remove_bg)}</strong><span>${esc(d.tool_bg_d)}</span></a>
${TOOLS.filter(t => t.slug !== tool.slug).map(t => `        <a class="tool-link" href="../${t.slug}/"><strong>${esc(d[t.nav])}</strong><span>${esc(d[t.desc])}</span></a>`).join('\n')}
      </div>
    </section>`;
      const footer = `  <footer class="site-footer">
    <p>© ${new Date().getFullYear()} ${esc(BRAND)}</p>
    <nav aria-label="${esc(d.foot_tools)}">
${navItems.map(([s, label]) => `      <a href="${link(s)}">${esc(label)}</a>`).join('\n')}
    </nav>
    <nav>
      <a href="${base}legal.html">${esc(d.foot_legal)}</a>
      <a href="${base}privacy.html">${esc(d.foot_privacy)}</a>
      <a href="${base}licenses.html">${esc(d.foot_licenses)}</a>
    </nav>
  </footer>`;
      const k = tool.key;
      const faq = [1, 2, 3, 4].map(i => ({ '@type': 'Question', name: d[`${k}q${i}`], acceptedAnswer: { '@type': 'Answer', text: d[`${k}a${i}`] } }));
      const jsonld = `  <script type="application/ld+json">${JSON.stringify([
        { '@context': 'https://schema.org', '@type': 'WebApplication', name: `${BRAND} · ${d[tool.nav]}`, url: urlFor(code), applicationCategory: 'MultimediaApplication', operatingSystem: 'Any', browserRequirements: 'Requires JavaScript and WebAssembly', inLanguage: code, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, description: d[`${k}_meta_desc`] },
        { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq },
      ]).replace(/</g, '\\u003c')}</script>`;
      const jsKeys = Object.fromEntries(Object.entries(d).filter(([key]) => key.startsWith('tj_')));
      const vars = {
        lang: code, dir: RTL.has(code) ? 'rtl' : 'ltr', brand: esc(BRAND), base, site_url: SITE_URL, slug: tool.slug,
        canonical: urlFor(code), alternates, jsonld, redirect: code === 'en' ? redirect : '',
        header, footer, moretools, i18njson: JSON.stringify(jsKeys).replace(/</g, '\\u003c'),
      };
      const html = tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        if (key in vars) return vars[key];
        if (key in d) return esc(d[key]);
        console.warn(`[${code}] clé inconnue dans ${tool.tpl} : ${key}`);
        return key;
      });
      const out = code === 'en' ? `site/${tool.slug}/index.html` : `site/${code}/${tool.slug}/index.html`;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, html);
    }
  }
  console.log(`OK : ${TOOLS.length} outils × ${ORDER.length} langues`);
  return urls;
}
