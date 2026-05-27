// api/topview.js — Vercel serverless
// Soporta: PSD upload → extrae frente/espalda → TopView → devuelve URLs
// También: proxy de imágenes y llamadas genéricas a la API de TopView

export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

const TOPVIEW_UID = '8EOyIj2GRQ0Ksxi0qEc4';
const API_KEY     = 'sk-dPXUdN-0XmRsv6u7wPfu_Jl5lZKC11HOsCvMESsEA34';
const BASE        = 'https://www.topview.ai';

const TEMPLATE_FRONT_FILE_ID = '7d7621e822644dd6ad2a997c4c71c609';
const TEMPLATE_BACK_FILE_ID  = '6a4e9340ec364a60a75bf22cd13604ae';
const MASK_FRONT_FILE_ID     = '38baaeb1c16f4ec1ab994b94b69820f0';
const MASK_BACK_FILE_ID      = '03b2ad6a11a44c7283e7cfac5e2733d5';

// ─── Helper: llamada a TopView ────────────────────────────────────
async function tvCall(path, body) {
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

// ─── Helper: upload imagen base64 a TopView ───────────────────────
async function uploadToTopView(base64) {
  const imageBuffer = Buffer.from(base64, 'base64');
  const boundary   = `----FB${Date.now()}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shirt.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
  );
  const footer   = Buffer.from(`\r\n--${boundary}--\r\n`);
  const formData = Buffer.concat([header, imageBuffer, footer]);

  const res = await fetch(`${BASE}/api/open/v1/file/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Topview-Uid': TOPVIEW_UID,
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: formData,
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error('Upload failed: ' + JSON.stringify(data));
  return data.data.fileId;
}

// ─── Helper: poll hasta que la tarea termina ──────────────────────
async function pollTask(taskId, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const data = await tvCall('/api/open/v3/product/model/query', { taskId });
    if (data.code !== 0) throw new Error('Query failed: ' + JSON.stringify(data));
    if (data.data.status === 'success') return data.data.resultUrl;
    if (data.data.status === 'failed')  throw new Error('Task failed');
  }
  throw new Error('Timeout');
}

// ─── Handler principal ────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ?proxy=URL — proxy de imágenes (para Canvas cross-origin) ─
  if (req.method === 'GET' && req.query.proxy) {
    const imgUrl = decodeURIComponent(req.query.proxy);
    const imgRes = await fetch(imgUrl);
    const buf    = Buffer.from(await imgRes.arrayBuffer());
    res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(buf);
  }

  // ── POST /api/topview?path=... — proxy genérico a TopView ─────────
  if (req.method === 'POST' && req.query.path) {
    const path = decodeURIComponent(req.query.path);

    if (path.includes('/file/upload')) {
      const fileId = await uploadToTopView(req.body.imageBase64);
      return res.status(200).json({ code: 0, data: { fileId } });
    }

    const data = await tvCall(path, req.body);
    return res.status(200).json(data);
  }

  // ── POST /api/topview (sin path) — flujo completo desde PSD ───────
  if (req.method === 'POST' && !req.query.path && !req.query.proxy) {
    const { frontBase64, backBase64 } = req.body;
    if (!frontBase64 || !backBase64)
      return res.status(400).json({ error: 'Faltan frontBase64 y/o backBase64' });

    try {
      // 1. Subir ambas imágenes en paralelo
      const [frontFileId, backFileId] = await Promise.all([
        uploadToTopView(frontBase64),
        uploadToTopView(backBase64),
      ]);

      // 2. Crear tareas en paralelo
      const [frontTask, backTask] = await Promise.all([
        tvCall('/api/open/v3/product/model/create', {
          productFileId:  frontFileId,
          templateFileId: TEMPLATE_FRONT_FILE_ID,
          maskFileId:     MASK_FRONT_FILE_ID,
        }),
        tvCall('/api/open/v3/product/model/create', {
          productFileId:  backFileId,
          templateFileId: TEMPLATE_BACK_FILE_ID,
          maskFileId:     MASK_BACK_FILE_ID,
        }),
      ]);

      if (frontTask.code !== 0) throw new Error('Front task error: ' + JSON.stringify(frontTask));
      if (backTask.code  !== 0) throw new Error('Back task error: '  + JSON.stringify(backTask));

      // 3. Polling en paralelo
      const [frontUrl, backUrl] = await Promise.all([
        pollTask(frontTask.data.taskId),
        pollTask(backTask.data.taskId),
      ]);

      return res.status(200).json({ frontUrl, backUrl });

    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
