import { metadataForPath } from './utils.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isNavigation = request.method === 'GET' && request.headers.get('Sec-Fetch-Mode') === 'navigate';
    if (!isNavigation) return env.ASSETS.fetch(request);

    const assetUrl = new URL('/__oktw_spa_shell__', url.origin);
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    const metadata = metadataForPath(url.pathname);
    const imageUrl = `${url.origin}/og.png`;

    return new HTMLRewriter()
      .on('title', { element: (element) => element.setInnerContent(metadata.title) })
      .on('meta[name="description"]', { element: (element) => element.setAttribute('content', metadata.description) })
      .on('meta[property="og:title"]', { element: (element) => element.setAttribute('content', metadata.title) })
      .on('meta[property="og:description"]', { element: (element) => element.setAttribute('content', metadata.description) })
      .on('meta[name="twitter:title"]', { element: (element) => element.setAttribute('content', metadata.title) })
      .on('meta[name="twitter:description"]', { element: (element) => element.setAttribute('content', metadata.description) })
      .on('meta[property="og:image"]', {
        element: (element) => metadata.useSiteImage ? element.setAttribute('content', imageUrl) : element.remove(),
      })
      .on('meta[name="twitter:image"]', {
        element: (element) => metadata.useSiteImage ? element.setAttribute('content', imageUrl) : element.remove(),
      })
      .transform(response);
  },
};
