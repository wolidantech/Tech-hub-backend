import { readFileSync } from 'node:fs';

const LOGO = readFileSync(new URL('../../assets/brand/danqel-digital-institute.svg', import.meta.url), 'utf8');
const MARK = readFileSync(new URL('../../assets/brand/danqel-mark.svg', import.meta.url), 'utf8');

function serveSvg(svg) {
  return (_req, res) => {
    res.type('image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.send(svg);
  };
}

/** Mount cacheable public SVGs for the institute's full logo and compact mark. */
export function mountBrandAssetRoutes(app) {
  app.get('/brand/logo.svg', serveSvg(LOGO));
  app.get('/brand/mark.svg', serveSvg(MARK));
}
