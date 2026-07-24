const { put, list, del } = require('@vercel/blob');

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const MAX_BYTES = 1500000;

// Vercel Blob's public CDN caches by pathname regardless of query string, so
// overwriting the same pathname (even with cacheControlMaxAge:0 and a
// cache-busting query param on read) can intermittently serve stale content.
// To get real read-after-write consistency we write each version to a NEW,
// never-before-seen pathname (timestamp-based) and always read the newest one.
function versionedPathname(code) {
  return 'family/' + code + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json';
}
function prefixFor(code) {
  return 'family/' + code + '/';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  try {
    const code = String((req.query && req.query.code) || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      res.status(400).json({ error: 'invalid_code' });
      return;
    }
    const prefix = prefixFor(code);

    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: prefix });
      if (!blobs.length) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      blobs.sort(function (a, b) { return a.pathname < b.pathname ? 1 : -1; });
      const latest = blobs[0];
      const r = await fetch(latest.url, { cache: 'no-store' });
      const data = await r.json();
      res.status(200).json({ data: data, updatedAt: latest.uploadedAt });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = null; }
      }
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      const payload = JSON.stringify(body);
      if (payload.length > MAX_BYTES) {
        res.status(413).json({ error: 'too_large' });
        return;
      }
      const blob = await put(versionedPathname(code), payload, {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'application/json',
        cacheControlMaxAge: 0
      });
      try {
        const cleanupList = await list({ prefix: prefix });
        const stale = cleanupList.blobs.filter(function (b) { return b.pathname !== blob.pathname; }).map(function (b) { return b.pathname; });
        if (stale.length) { await del(stale); }
      } catch (cleanupErr) { /* best-effort cleanup only */ }
      res.status(200).json({ ok: true, updatedAt: blob.uploadedAt });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
};
