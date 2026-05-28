# api/psd.py — Vercel Python serverless function
# Procesa PSDs con psd-tools (maneja shape layers, vector paths, etc.)
# Retorna frente y espalda como JPEG base64

from http.server import BaseHTTPRequestHandler
import json, base64, io, os, tempfile

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            data   = json.loads(body)
            psd_b64 = data.get('psdBase64', '')
            if not psd_b64:
                raise ValueError('psdBase64 requerido')

            psd_bytes = base64.b64decode(psd_b64)

            # Escribir a temp file y procesar
            import psd_tools
            from PIL import Image
            import numpy as np

            with tempfile.NamedTemporaryFile(suffix='.psd', delete=False) as f:
                f.write(psd_bytes)
                tmp_path = f.name

            psd = psd_tools.PSDImage.open(tmp_path)
            os.unlink(tmp_path)

            front_b64, back_b64 = process_psd(psd)

            self._respond(200, {'frontBase64': front_b64, 'backBase64': back_b64})

        except Exception as e:
            self._respond(500, {'error': str(e)})

    def _respond(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def find_layer(layers, name):
    for l in layers:
        if l.name == name:
            return l
    return None

def find_nested(root, *path):
    cur = root
    for s in path:
        cur = find_layer(cur, s)
        if not cur: return None
    return cur

def whiten_arr(arr):
    alpha = arr[:,:,3]
    for c in range(3):
        ch = arr[:,:,c].astype(float)
        shirt_area = (alpha > 10) & (ch > 120)
        if shirt_area.sum() > 0:
            mn, mx = ch[shirt_area].min(), ch[shirt_area].max()
            ch[shirt_area] = 200 + (ch[shirt_area] - mn) / max(mx - mn, 1) * 55
        arr[:,:,c] = ch.astype(np.uint8)
    return arr

def to_jpeg_b64(img, max_dim=1400, quality=92):
    import numpy as np
    w, h = img.size
    if max(w, h) > max_dim:
        s = max_dim / max(w, h)
        img = img.resize((round(w*s), round(h*s)), Image.LANCZOS)
    rgb = Image.new('RGB', img.size, (255,255,255))
    if img.mode == 'RGBA':
        rgb.paste(img, mask=img.split()[3])
    else:
        rgb.paste(img)
    buf = io.BytesIO()
    rgb.save(buf, format='JPEG', quality=quality)
    return base64.b64encode(buf.getvalue()).decode()

def process_psd(psd):
    import numpy as np
    W, H = psd.width, psd.height

    def composite_shirt(shirt_name, stamp_name):
        main_obj = find_nested(psd, 'Working Process', shirt_name, 'Objects', 'Main Object')
        if not main_obj:
            return None

        canvas = Image.new('RGBA', (W, H), (0,0,0,0))

        # Shirt base (whitened)
        shirt = main_obj.topil().convert('RGBA')
        arr = np.array(shirt)
        arr = whiten_arr(arr)
        shirt_white = Image.fromarray(arr)
        bbox = main_obj.bbox
        canvas.paste(shirt_white, (bbox[0], bbox[1]), shirt_white)

        # Stamp
        stamp = find_layer(list(psd), stamp_name)
        if stamp:
            stamp_img = stamp.composite()
            if stamp_img is not None:
                stamp_rgba = stamp_img.convert('RGBA')
                arr_s = np.array(stamp_rgba)
                if (arr_s[:,:,3] > 10).sum() > 50:
                    sbbox = stamp.bbox
                    canvas.paste(stamp_rgba, (sbbox[0], sbbox[1]), stamp_rgba)

        return canvas.crop((bbox[0], bbox[1], bbox[2], bbox[3]))

    front = composite_shirt('Left Shirt',  'Estampa Frontal')
    back  = composite_shirt('Right Shirt', 'Estampa Espalda')

    return to_jpeg_b64(front), to_jpeg_b64(back)
