export const config = { runtime: 'edge' };

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Topview-Uid, Accept',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const targetPath = url.searchParams.get('path');
    const query = url.searchParams.get('query') || '';

    if (!targetPath) {
      return new Response(JSON.stringify({ error: 'Missing path' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Build final TopView URL — decode query so it arrives unescaped
    const decodedQuery = decodeURIComponent(query);
    const targetUrl = `https://api.topview.ai${targetPath}${decodedQuery ? '?' + decodedQuery : ''}`;

    const forwardHeaders = { 'Accept': '*/*' };
    const uid = req.headers.get('Topview-Uid');
    const auth = req.headers.get('Authorization');
    const ct = req.headers.get('Content-Type');
    if (uid) forwardHeaders['Topview-Uid'] = uid;
    if (auth) forwardHeaders['Authorization'] = auth;
    if (ct && req.method !== 'GET') forwardHeaders['Content-Type'] = ct;

    let body = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 0) body = buf;
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });

    const data = await response.arrayBuffer();

    return new Response(data, {
      status: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
