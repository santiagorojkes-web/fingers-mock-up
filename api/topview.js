// api/topview.js — Vercel serverless proxy for TopView API
// Handles: API calls (POST) and image proxying (GET ?proxy=URL)

const TOPVIEW_UID = '8EOyIj2GRQ0Ksxi0qEc4';
const API_KEY = 'sk-dPXUdN-0XmRsv6u7wPfu_Jl5lZKC11HOsCvMESsEA34';
const TOPVIEW_BASE = 'https://www.topview.ai';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Image proxy (GET ?proxy=URL) ──────────────────────────────────
  // Needed because TopView result images may block browser direct fetch (CORS)
  if (req.method === 'GET' && req.query.proxy) {
    try {
      const imgUrl = decodeURIComponent(req.query.proxy);
      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) {
        return res.status(imgRes.status).json({ error: 'Image fetch failed' });
      }
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(buffer);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── TopView API proxy (POST) ──────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const path = decodeURIComponent(req.query.path || '');
  if (!path || !path.startsWith('/api/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  try {
    const body = req.body;
    let fetchOptions;

    // File upload: receives imageBase64, converts to multipart form
    if (path.includes('/file/upload')) {
      const { imageBase64 } = body;
      const imageBuffer = Buffer.from(imageBase64, 'base64');
      
      // Build multipart form manually
      const boundary = `----FormBoundary${Date.now()}`;
      const filename = 'product.jpg';
      
      const formParts = [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
        `Content-Type: image/jpeg\r\n\r\n`,
      ];
      const formHeader = Buffer.from(formParts.join(''));
      const formFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
      const formData = Buffer.concat([formHeader, imageBuffer, formFooter]);

      fetchOptions = {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': formData.length,
          'Topview-Uid': TOPVIEW_UID,
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: formData,
      };
    } else {
      // JSON API call
      fetchOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Topview-Uid': TOPVIEW_UID,
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
      };
    }

    const tvRes = await fetch(`${TOPVIEW_BASE}${path}`, fetchOptions);
    const data = await tvRes.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('TopView proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}
