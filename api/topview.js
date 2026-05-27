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
    const queryString = url.searchParams.get('query') || '';

    if (!targetPath) {
      return new Response(JSON.stringify({ error: 'Missing path parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Build target URL — append query string directly
    const targetUrl = `https://api.topview.ai${targetPath}${queryString ? '?' + queryString : ''}`;

    // Forward only relevant headers
    const forwardHeaders = { 'Accept': '*/*' };
    const uid = req.headers.get('Topview-Uid');
    const auth = req.headers.get('Authorization');
    const contentType = req.headers.get('Content-Type');
    if (uid) forwardHeaders['Topview-Uid'] = uid;
    if (auth) forwardHeaders['Authorization'] = auth;
    // Only set Content-Type for non-GET requests with a body
    if (contentType && req.method !== 'GET') forwardHeaders['Content-Type'] = contentType;

    let body = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await req.arrayBuffer();
      if (body.byteLength === 0) body = undefined;
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });

    const responseData = await response.arrayBuffer();

    return new Response(responseData, {
      status: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
