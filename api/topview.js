// api/topview.js — Proxy correcto según documentación oficial de TopView
// Base URL real: https://api.topview.ai (NO www.topview.ai)
// Docs: https://docs.topview.ai/reference/upload-api-usage

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const UID     = '8EOyIj2GRQ0Ksxi0qEc4';
const KEY     = 'Bearer sk-dPXUdN-0XmRsv6u7wPfu_Jl5lZKC11HOsCvMESsEA34';
const API     = 'https://api.topview.ai';

const HEADERS = { 'Topview-Uid': UID, 'Authorization': KEY };

// ── Paso 1: obtener credencial de upload ──────────────────────────
async function getUploadCredential() {
  const r = await fetch(`${API}/v1/upload/credential?format=jpg`, {
    headers: { ...HEADERS, 'Accept': '*/*' }
  });
  const d = await safeJSON(r, 'credential');
  if (d.code !== '200') throw new Error(`Credential failed: ${JSON.stringify(d)}`);
  return d.result; // { fileId, uploadUrl, fileName }
}

// ── Paso 2: upload directo a S3 con pre-signed URL ────────────────
async function uploadToS3(uploadUrl, imageBuffer) {
  const r = await fetch(uploadUrl, {
    method: 'PUT',
    body: imageBuffer,
    headers: { 'Content-Type': 'image/jpeg' }
  });
  if (!r.ok) throw new Error(`S3 upload HTTP ${r.status}`);
}

// ── Paso 3: verificar que el upload llegó ─────────────────────────
async function checkUpload(fileId) {
  const r = await fetch(`${API}/v1/upload/check?fileId=${fileId}`, {
    headers: { ...HEADERS, 'Accept': '*/*' }
  });
  const d = await safeJSON(r, 'check');
  if (d.code !== '200' || d.result !== true)
    throw new Error(`Upload check failed: ${JSON.stringify(d)}`);
}

// ── Upload completo: credential → S3 → check ─────────────────────
async function uploadImage(base64) {
  const buf              = Buffer.from(base64, 'base64');
  const { fileId, uploadUrl } = await getUploadCredential();
  await uploadToS3(uploadUrl, buf);
  await checkUpload(fileId);
  return fileId;
}

// ── Helper: parse JSON con error claro ───────────────────────────
async function safeJSON(res, label) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
}

// ── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ?proxy=URL — imagen proxy para Canvas ──────────────────
  if (req.method === 'GET' && req.query.proxy) {
    try {
      const r   = await fetch(decodeURIComponent(req.query.proxy));
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type',  r.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(buf);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── GET ?query=taskId — consulta resultado tarea ───────────────
  if (req.method === 'GET' && req.query.query) {
    try {
      const r = await fetch(
        `${API}/v3/product_anyShoot/product_model/task/result?taskId=${encodeURIComponent(req.query.query)}`,
        { headers: HEADERS }
      );
      return res.status(200).json(await safeJSON(r, 'query'));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).end();

  // ── POST ?upload=1 — sube imagen y devuelve fileId ────────────
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

  // ── POST ?submit=front|back — crea tarea de generación ────────
  if (req.query.submit) {
    try {
      const { productImageFileId, templateImageFileId, templateMaskFileId } = req.body;
      const r = await fetch(`${API}/v3/product_anyShoot/product_model/task/submit`, {
        method:  'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productImageFileId,
          templateImageFileId,
          templateMaskFileId,
          generatingCount: '1',
        }),
      });
      return res.status(200).json(await safeJSON(r, 'submit'));
    } catch (e) {
      console.error('Submit error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Parámetro desconocido' });
}
