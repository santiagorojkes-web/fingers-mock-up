// api/topview.js — Vercel serverless proxy
// El servidor solo hace: upload + create task (rápido)
// El browser hace el polling para evitar timeout de Vercel

export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

const TOPVIEW_UID = '8EOyIj2GRQ0Ksxi0qEc4';
const API_KEY     = 'sk-dPXUdN-0XmRsv6u7wPfu_Jl5lZKC11HOsCvMESsEA34';
const BASE        = 'https://www.topview.ai';

const TEMPLATE_FRONT = '7d7621e822644dd6ad2a997c4c71c609';
const TEMPLATE_BACK  = '6a4e9340ec364a60a75bf22cd13604ae';
const MASK_FRONT     = '38baaeb1c16f4ec1ab994b94b69820f0';
const MASK_BACK      = '03b2ad6a11a44c7283e7cfac5e2733d5';

async function tvJSON(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Topview-Uid': TOPVIEW_UID,
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function uploadBase64(base64) {
  const buf      = Buffer.from(base64, 'base64');
  const boundary = `----FB${Date.now()}${Math.random().toString(36).slice(2)}`;
  const header   = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shirt.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  const footer   = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body     = Buffer.concat([header, buf, footer]);

  const res = await fetch(`${BASE}/api/open/v1/file/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Topview-Uid': TOPVIEW_UID,
      'Authorization': `Bearer ${API_KEY}`,
    },
    body,
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('Upload failed: ' + JSON.stringify(data));
  return data.data.fileId;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ?proxy=URL  →  imagen proxied (para Canvas crossOrigin) ──
  if (req.method === 'GET' && req.query.proxy) {
    try {
      const r   = await fetch(decodeURIComponent(req.query.proxy));
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).end();

  // ── POST ?path=...  →  proxy genérico a TopView (usado para polling) ──
  if (req.query.path) {
    const path = decodeURIComponent(req.query.path);
    try {
      if (path.includes('/file/upload')) {
        const fileId = await uploadBase64(req.body.imageBase64);
        return res.status(200).json({ code: 0, data: { fileId } });
      }
      const data = await tvJSON(path, req.body);
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST /api/topview  →  upload ambas imágenes + crear tareas
  //    Devuelve { frontTaskId, backTaskId } inmediatamente.
  //    El polling lo hace el browser para no exceder el timeout de Vercel.
  try {
    const { frontBase64, backBase64 } = req.body;
    if (!frontBase64 || !backBase64)
      return res.status(400).json({ error: 'Faltan frontBase64 y/o backBase64' });

    // Upload en paralelo
    const [frontFileId, backFileId] = await Promise.all([
      uploadBase64(frontBase64),
      uploadBase64(backBase64),
    ]);

    // Crear tareas en paralelo
    const [frontTask, backTask] = await Promise.all([
      tvJSON('/api/open/v3/product/model/create', {
        productFileId: frontFileId, templateFileId: TEMPLATE_FRONT, maskFileId: MASK_FRONT,
      }),
      tvJSON('/api/open/v3/product/model/create', {
        productFileId: backFileId,  templateFileId: TEMPLATE_BACK,  maskFileId: MASK_BACK,
      }),
    ]);

    if (frontTask.code !== 0) throw new Error('Front task: ' + JSON.stringify(frontTask));
    if (backTask.code  !== 0) throw new Error('Back task: '  + JSON.stringify(backTask));

    return res.status(200).json({
      frontTaskId: frontTask.data.taskId,
      backTaskId:  backTask.data.taskId,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
