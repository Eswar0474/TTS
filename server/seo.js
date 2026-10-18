import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// SITE_URL / config.siteUrl is an explicit bare origin, independent of request headers.
// The project's canonical production origin defaults to https://sonora.rawse.in.
export const DEFAULT_SITE_URL = 'https://sonora.rawse.in';
export const DEFAULT_GOOGLE_SITE_VERIFICATION = 'WKcjy6CTtDshP2gWiMossBKitVn-jvi6uJPzpugyFSE';
const TITLE = 'Sonora Voice Studio — AI Text to Speech & Audio';
const DESCRIPTION = 'Turn scripts into expressive AI voice narrations with Sonora Voice Studio. Choose a voice, preview speech, and export MP3, WAV, FLAC, AAC, or OGG audio.';
const GUIDE_TITLE = 'How It Works & FAQ — Sonora Voice Studio';
const GUIDE_DESCRIPTION = 'Learn how Sonora Voice Studio turns scripts into expressive AI voice narrations, how delivery tags and exports work, and how daily allowances apply.';
const PRICING_TITLE = 'Plans & Pricing — Sonora Voice Studio';
const PRICING_DESCRIPTION = 'Compare Sonora Voice Studio monthly plans, daily word allowances, model access, and audio export formats.';
const HEAD_START = '<!-- seo:head:start -->';
const HEAD_END = '<!-- seo:head:end -->';
const NOINDEX = 'noindex, nofollow';

const GUIDE_FAQ = Object.freeze([
  ['How does the daily word allowance work?', 'Guests can submit up to 50 whitespace-separated words per IP per UTC day. Signed-in Google accounts can submit up to 1,000 words per account per UTC day. Words in the script and delivery tags both count. Allowances reset at 00:00 UTC.'],
  ['Which models can I use?', 'Guests can use Low Quality. Signed-in free accounts can use Low Quality and Balanced. Enhanced Thinking is temporarily restricted to admins while paid-plan verification is built.'],
  ['Which audio formats can I export?', 'Free accounts can download MP3. Plus and higher plans are intended to include WAV, FLAC, AAC, and OGG after billing and subscription verification are available.'],
  ['Will tags produce an exact voice delivery?', 'Tags guide delivery, but generated output is not guaranteed to match the requested delivery exactly.'],
  ['Can I generate, preview, or export audio without JavaScript?', 'JavaScript is required for generation, preview, and export.']
]);

function canonicalOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s/?#\\]+$/i.test(value)) {
    throw new Error('SITE_URL must be a bare HTTP(S) origin without credentials, path, query, or hash.');
  }
  let url;
  try { url = new URL(value); }
  catch { throw new Error('SITE_URL must be a valid bare HTTP(S) origin.'); }
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
    throw new Error('SITE_URL must be a bare HTTP(S) origin without credentials, path, query, or hash, and use HTTPS in production.');
  }
  return url.origin;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function headMarkup({ title: titleValue, description: descriptionValue, url: urlValue, schema }, verification) {
  const title = escapeHtml(titleValue);
  const description = escapeHtml(descriptionValue);
  const url = escapeHtml(urlValue);
  const ownership = typeof verification === 'string' ? verification.trim() : verification;
  const jsonLd = JSON.stringify(schema).replace(/</g, '\\u003c');
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${url}" />`,
    '<meta name="robots" content="index, follow" />',
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Sonora Voice Studio" />',
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    ...(ownership == null || ownership === '' ? [] :
      [`<meta name="google-site-verification" content="${escapeHtml(ownership)}" />`]),
    `<script type="application/ld+json">${jsonLd}</script>`
  ];
}

function homeSchema(home) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${home}#website`, name: 'Sonora Voice Studio', url: home, description: DESCRIPTION },
      { '@type': 'WebApplication', '@id': `${home}#application`, name: 'Sonora Voice Studio', url: home, description: DESCRIPTION,
        applicationCategory: 'MultimediaApplication', operatingSystem: 'Web', isPartOf: { '@id': `${home}#website` } }
    ]
  };
}

function guideSchema(url) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': `${url}#webpage`, url, name: GUIDE_TITLE, description: GUIDE_DESCRIPTION, inLanguage: 'en' },
      { '@type': 'FAQPage', '@id': `${url}#faq`, url: `${url}#faq`, mainEntity: GUIDE_FAQ.map(([name, text]) => ({
        '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text }
      })) }
    ]
  };
}

function replaceHead(html, lines) {
  const start = html.indexOf(HEAD_START);
  const end = html.indexOf(HEAD_END);
  if (start < 0 || end < start + HEAD_START.length ||
      html.indexOf(HEAD_START, start + HEAD_START.length) !== -1 ||
      html.indexOf(HEAD_END, end + HEAD_END.length) !== -1) {
    throw new Error('Built index.html must contain exactly one SEO head marker pair.');
  }
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  const prefix = html.slice(html.lastIndexOf('\n', start) + 1, start);
  const indent = /^[ \t]*$/.test(prefix) ? prefix : '';
  return html.slice(0, start + HEAD_START.length) + newline +
    lines.map(line => indent + line).join(newline) + newline + indent + html.slice(end);
}

export function privateNoindex(req, res, next) {
  res.set('X-Robots-Tag', NOINDEX);
  next();
}

export function createSeoRouter({
  publicDir,
  siteUrl = DEFAULT_SITE_URL,
  googleSiteVerification = DEFAULT_GOOGLE_SITE_VERIFICATION,
  logger = console
}) {
  const origin = canonicalOrigin(siteUrl);
  const home = `${origin}/`;
  const guide = `${origin}/how-it-works`;
  const pricing = `${origin}/pricing`;
  const router = express.Router();
  const pages = {
    home: { file: 'index.html', title: TITLE, description: DESCRIPTION, url: home, schema: homeSchema(home) },
    guide: { file: 'how-it-works.html', title: GUIDE_TITLE, description: GUIDE_DESCRIPTION, url: guide, schema: guideSchema(guide) },
    pricing: { file: 'pricing.html', title: PRICING_TITLE, description: PRICING_DESCRIPTION, url: pricing, schema: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': `${pricing}#webpage`,
      url: pricing,
      name: PRICING_TITLE,
      description: PRICING_DESCRIPTION,
      inLanguage: 'en'
    } }
  };
  const servePage = page => async (req, res) => {
    try {
      const html = await readFile(path.join(publicDir, page.file), 'utf8');
      const head = headMarkup(page, googleSiteVerification);
      return res.set('Cache-Control', 'public, max-age=0, must-revalidate')
        .type('html')
        .send(replaceHead(html, head));
    } catch (error) {
      logger.error?.(`[sonora] Public ${page.file} is unavailable`, {
        name: error instanceof Error ? error.name : 'UnknownError'
      });
      return res.status(503).set('X-Robots-Tag', NOINDEX).type('text/plain').send('Site is temporarily unavailable.');
    }
  };

  router.get('/robots.txt', (req, res) => res
    .set('Cache-Control', 'public, max-age=3600')
    .type('text/plain')
    .send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nSitemap: ${origin}/sitemap.xml\n`));
  router.get('/sitemap.xml', (req, res) => res
    .set('Cache-Control', 'public, max-age=3600')
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[home, guide, pricing].map(url => `  <url><loc>${escapeHtml(url)}</loc></url>`).join('\n')}\n</urlset>\n`));
  router.get('/index.html', (req, res) => res.redirect(301, '/'));
  router.get('/how-it-works.html', (req, res) => res.redirect(301, '/how-it-works'));
  router.get('/how-it-works/', (req, res, next) => req.path === '/how-it-works/'
    ? res.redirect(301, '/how-it-works')
    : next());
  router.get('/pricing.html', (req, res) => res.redirect(301, '/pricing'));
  router.get('/pricing/', (req, res, next) => req.path === '/pricing/'
    ? res.redirect(301, '/pricing')
    : next());
  router.get('/how-it-works', servePage(pages.guide));
  router.get('/pricing', servePage(pages.pricing));
  router.get('/', servePage(pages.home));
  router.use(['/api', '/auth'], (req, res) => res.status(404)
    .set('X-Robots-Tag', NOINDEX).type('text/plain').send('Not found.'));
  router.use(express.static(publicDir, { index: false, redirect: false, maxAge: '1h' }));
  router.use((req, res) => res.status(404).set('X-Robots-Tag', NOINDEX).type('text/plain').send('Not found.'));
  return router;
}
