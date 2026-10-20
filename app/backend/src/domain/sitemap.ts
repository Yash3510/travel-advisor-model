// sitemap.xml: the public pages only (no chat, account or private share links)
import { guideList } from './guide.js';
import { sampleList } from './samples.js';

const PAGES = ['/', '/how-it-works', '/destinations', '/trips', '/about', '/faq', '/contact', '/privacy', '/terms', '/cookies'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function sitemap(origin: string): string {
  const paths = [...PAGES, ...guideList().map((d) => `/destinations/${d.slug}`), ...sampleList().map((s) => `/trips/${s.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    paths.map((p) => `  <url><loc>${esc(origin + p)}</loc></url>`).join('\n')}\n</urlset>\n`;
}
