// api/topview.js — Proxy para TopView API (api.topview.ai)

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const UID  = '8EOyIj2GRQ0Ksxi0qEc4';
const KEY  = 'Bearer sk-dPXUdN-0XmRsv6u7wPfu_Jl5lZKC11HOsCvMESsEA34';
const API  = 'https://api.topview.ai';
const HDR  = { 'Topview-Uid': UID, 'Authorization': KEY, 'Accept': '*/*' };

async function safeJSON(res, label) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`); }
}

// ── Upload: 3 pasos (credential → S3 PUT → check) ─────────────────
async function uploadImage(base64) {
  // 1. Credential
  const r1  = await fetch(`${API}/v1/upload/credential?format=jpg`, { headers: HDR });
  const d1  = await safeJSON(r1, 'credential');
  if (d1.code !== '200') throw new Error(`Credential: ${JSON.stringify(d1)}`);
  const { fileId, uploadUrl } = d1.result;

  // 2. PUT a S3
  const buf = Buffer.from(base64, 'base64');
  const r2  = await fetch(uploadUrl, { method: 'PUT', body: buf, headers: { 'Content-Type': 'image/jpeg' } });
  if (!r2.ok) throw new Error(`S3 upload HTTP ${r2.status}`);

  // 3. Check
  const r3 = await fetch(`${API}/v1/upload/check?fileId=${fileId}`, { headers: HDR });
  const d3 = await safeJSON(r3, 'check');
  if (d3.code !== '200' || d3.result !== true) throw new Error(`Check: ${JSON.stringify(d3)}`);

  return fileId;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET ?proxy=URL — imagen proxy para Canvas (crossOrigin)
  if (req.method === 'GET' && req.query.proxy) {
    try {
      const r   = await fetch(decodeURIComponent(req.query.proxy));
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type',  r.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(buf);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // GET ?query=taskId — consulta resultado
  if (req.method === 'GET' && req.query.query) {
    try {
      const r = await fetch(
        `${API}/v3/product_anyShoot/product_model/task/result?taskId=${encodeURIComponent(req.query.query)}`,
        { headers: HDR }
      );
      // Devolver la respuesta tal cual para que el browser la interprete
      return res.status(200).json(await safeJSON(r, 'query'));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).end();

  // POST ?upload=1 — sube imagen, devuelve fileId
  if (req.query.upload) {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) throw new Error('imageBase64 requerido');
      const fileId = await uploadImage(imageBase64);
      return res.status(200).json({ ok: true, fileId });
    } catch (e) {
      console.error('Upload error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // POST ?submit=1 — crea tarea, devuelve taskId
  if (req.query.submit) {
    try {
      const { productImageFileId, templateImageFileId, templateMaskFileId } = req.body;
      const r = await fetch(`${API}/v3/product_anyShoot/product_model/task/submit`, {
        method:  'POST',
        headers: { ...HDR, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productImageFileId, templateImageFileId, templateMaskFileId, generatingCount: '1' }),
      });
      const d = await safeJSON(r, 'submit');

      // La API devuelve code "200" y taskId en result.taskId (o directo en d.taskId)
      if (d.code !== '200') throw new Error(`Submit: ${JSON.stringify(d)}`);
      const taskId = d.result?.taskId ?? d.taskId;
      if (!taskId) throw new Error(`taskId no encontrado en: ${JSON.stringify(d)}`);

      return res.status(200).json({ ok: true, taskId });
    } catch (e) {
      console.error('Submit error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Parámetro desconocido' });
}
