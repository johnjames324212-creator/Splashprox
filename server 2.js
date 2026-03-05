const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS: allow all origins so SPLASH can talk to this server ──
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Serve the frontend ──
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────
//  MAIN PROXY ROUTE:  GET /proxy?url=https://...
// ────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const target = req.query.url;

  if (!target) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  // Basic URL validation
  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Block private/local IPs (security)
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '10.', '192.168.', '172.'];
  if (blocked.some(b => targetUrl.hostname.startsWith(b))) {
    return res.status(403).json({ error: 'Blocked target' });
  }

  try {
    const agent = targetUrl.protocol === 'https:'
      ? new https.Agent({ rejectUnauthorized: false })
      : new http.Agent();

    const proxyRes = await fetch(targetUrl.toString(), {
      method: 'GET',
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Referer': targetUrl.origin,
        'Origin': targetUrl.origin,
      },
      redirect: 'follow',
      timeout: 15000,
      size: 10 * 1024 * 1024, // 10MB max
    });

    // Forward content-type
    const contentType = proxyRes.headers.get('content-type') || 'text/html';
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Proxied-By', 'SPLASH-Proxy');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Remove security headers that would block embedding
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');

    const buffer = await proxyRes.buffer();
    let body = buffer.toString('utf8');

    // ── Rewrite HTML: fix relative URLs and inject base tag ──
    if (contentType.includes('text/html')) {
      const base = `${targetUrl.protocol}//${targetUrl.host}`;
      const basePath = targetUrl.pathname.replace(/\/[^/]*$/, '/') || '/';

      // Inject base tag for relative links
      body = body.replace(/<head([^>]*)>/i, `<head$1><base href="${base}${basePath}">`);

      // Rewrite absolute URLs in src/href to go through our proxy
      body = body.replace(/(src|href|action)=["'](https?:\/\/[^"']+)["']/gi, (match, attr, url) => {
        return `${attr}="/proxy?url=${encodeURIComponent(url)}"`;
      });

      // Remove frame-busting scripts
      body = body.replace(/if\s*\(\s*(?:top|parent|window\.top)\s*[!=]=\s*(?:self|window)\s*\)/gi, 'if(false)');
      body = body.replace(/top\.location(?:\.href)?\s*=/gi, '//__BLOCKED__=');
      body = body.replace(/window\.top\.location(?:\.href)?\s*=/gi, '//__BLOCKED__=');
    }

    res.status(proxyRes.status).send(body);

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Proxy fetch failed', detail: err.message });
  }
});

// ── POST /proxy — for form submissions ──
app.post('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing ?url=' });
  try {
    const proxyRes = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams(req.body).toString(),
      redirect: 'follow',
      timeout: 15000,
    });
    const contentType = proxyRes.headers.get('content-type') || 'text/html';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const text = await proxyRes.text();
    res.status(proxyRes.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check (keeps Render free tier awake) ──
app.get('/health', (req, res) => {
  res.json({ status: 'online', server: 'SPLASH-Proxy', time: new Date().toISOString() });
});

// ── Root → serve frontend ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SPLASH Proxy running on port ${PORT}`);
});
