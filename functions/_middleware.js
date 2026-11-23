// Search metadata that names the production domain, added at the edge.
//
// The domain is not committed. Set SITE_ORIGIN (e.g. https://example.org) as a
// Pages environment variable for production. Without it every request passes
// through untouched, so preview and pages.dev deployments get no canonical
// link and no sitemap. With it, the page gains its canonical link and og:url,
// and robots.txt / sitemap.xml name the sitemap. _routes.json limits this
// Function to those paths, so the app's static assets never invoke it.

function siteOrigin(env) {
  try {
    const url = new URL(env.SITE_ORIGIN);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

function text(body, type) {
  return new Response(body, {
    headers: {
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function onRequest({ request, env, next }) {
  const origin = siteOrigin(env);
  const { pathname } = new URL(request.url);

  if (origin && pathname === '/robots.txt') {
    return text(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`, 'text/plain');
  }
  if (origin && pathname === '/sitemap.xml') {
    return text(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + `  <url>\n    <loc>${origin}/</loc>\n  </url>\n`
        + '</urlset>\n',
      'application/xml',
    );
  }

  const response = await next();
  if (pathname !== '/' && pathname !== '/index.html') return response;
  if (!(response.headers.get('Content-Type') || '').includes('text/html')) return response;

  const page = new Response(response.body, response);
  page.headers.set('Cache-Control', 'no-cache');
  page.headers.set('X-Content-Type-Options', 'nosniff');
  page.headers.set('X-Frame-Options', 'DENY');
  page.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  page.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  page.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  page.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  if (!origin) return page;

  const home = `${origin}/`;
  return new HTMLRewriter()
    .on('head', {
      element(head) {
        head.append(
          `<link rel="canonical" href="${home}">\n<meta property="og:url" content="${home}">\n`,
          { html: true },
        );
      },
    })
    .transform(page);
}
