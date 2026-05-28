// api/topview.js — Vercel serverless proxy

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const TOPVIEW_UID = '8EOyIj2GRQ0Ksxi0qEc4';
const API_KEY     = 'sk-dPXUdN-0XmRsv6u7wPfu_Jl5lZKC11HOsCvMESsEA34';
const BASE        = 'https://www.topview.ai';

// ── Upload usando FormData nativo de Node 18 ──────────────────────
async function uploadBase64(base64) {
  const imageBuffer = Buffer.from(base64, 'base64');
  const blob        = new Blob([imageBuffer], { type: 'image/jpeg' });
  const form        = new FormData();
  form.append('file', blob, 'shirt.jpg');

  const res = await fetch(`${BASE}/api/open/v1/file/upload`, {
    method: 'POST',
    headers: {
      'Topview-Uid':    TOPVIEW_UID,
      'Authorization':  `Bearer ${API_KEY}`,
      // NO Content-Type → fetch lo pone automático con el boundary correcto
    },
    body: form,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`TopView upload no-JSON (${res.status}): ${text.slice(0, 300)}`); }

  if (data.code !== 0) throw new Error('TopView upload error: ' + JSON.stringify(data));
  return data.data.fileId;
}

// ── Llamada JSON genérica a TopView ──────────────────────────────
async function tvJSON(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Topview-Uid':   TOPVIEW_UID,
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`TopView no-JSON (${res.status}): ${text.slice(0, 300)}`); }
}

// ── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET ?proxy=URL — proxy de imagen para Canvas crossOrigin
  if (req.method === 'GET' && req.query.proxy) {
    try {
      const r   = await fetch(decodeURIComponent(req.query.proxy));
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type',  r.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).end();

  // POST ?path=... — proxy genérico (usado por el browser para upload y polling)
  if (req.query.path) {
    const path = decodeURIComponent(req.query.path);
    try {
      if (path.includes('/file/upload')) {
        const { imageBase64 } = req.body;
        if (!imageBase64) throw new Error('imageBase64 no recibido');
        const fileId = await uploadBase64(imageBase64);
        return res.status(200).json({ code: 0, data: { fileId } });
      }
      // Cualquier otra llamada JSON (create task, query, etc.)
      const data = await tvJSON(path, req.body);
      return res.status(200).json(data);
    } catch (e) {
      console.error('Proxy error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Missing path or proxy param' });
}
