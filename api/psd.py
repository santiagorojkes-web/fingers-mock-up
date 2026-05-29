# api/psd.py — Vercel Python Serverless Function
# Procesa PSDs con psd-tools (soporta shape layers, pixel layers, vectores)
# Recibe el PSD como multipart/form-data

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
            ct  = self.headers.get('Content-Type', '')
            cl  = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(cl)

            psd_bytes = None

            if 'multipart/form-data' in ct:
                psd_bytes = parse_multipart(raw, ct)
            else:
                psd_bytes = raw

            if not psd_bytes:
                return self._json(400, {'error': 'No se recibió archivo PSD'})

            result = process_psd(psd_bytes)
            self._json(200, result)

        except Exception as e:
            import traceback
            self._json(500, {'error': str(e), 'trace': traceback.format_exc()})

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def parse_multipart(raw: bytes, content_type: str) -> bytes:
    """Parser multipart/form-data sin depender de cgi (deprecado en Python 3.11+)."""
    boundary = None
    for part in content_type.split(';'):
        part = part.strip()
        if part.startswith('boundary='):
            boundary = part[9:].strip('"')
            break
    if not boundary:
        raise ValueError('No se encontró boundary en Content-Type')

    sep = ('--' + boundary).encode()
    parts = raw.split(sep)
    for part in parts:
        if not part or part.strip() == b'--':
            continue
        if b'\r\n\r\n' not in part:
            continue
        headers_raw, body = part.split(b'\r\n\r\n', 1)
        headers_str = headers_raw.decode('utf-8', errors='replace')
        if 'name="file"' in headers_str or "name='file'" in headers_str:
            if body.endswith(b'\r\n'):
                body = body[:-2]
            return body

    raise ValueError('No se encontró el campo "file" en el multipart')


def find_layer(layers, name):
    for l in layers:
        if l.name == name:
            return l
    return None


def find_nested(root, *path):
    cur_children = getattr(root, 'layers', None) or []
    cur = None
    for step in path:
        cur = find_layer(cur_children, step)
        if not cur:
            return None
        cur_children = getattr(cur, 'layers', None) or []
    return cur


def whiten_image(img):
    """Normaliza blancos/grises a blanco puro."""
    import numpy as np
    arr = np.array(img.convert('RGBA'))
    alpha = arr[:, :, 3]
    mask = (alpha > 10) & (arr[:, :, 0] > 120) & (arr[:, :, 1] > 120) & (arr[:, :, 2] > 120)
    if mask.sum() == 0:
        return img
    for c in range(3):
        ch = arr[:, :, c].astype(float)
        vals = ch[mask]
        mn, mx = vals.min(), vals.max()
        if mx > mn:
            ch[mask] = 200 + (ch[mask] - mn) / (mx - mn) * 55
        arr[:, :, c] = ch.clip(0, 255).astype('uint8')
    from PIL import Image
    return Image.fromarray(arr)


def img_to_b64(img, max_dim=1400, quality=92):
    """PIL Image → JPEG base64, con resize opcional."""
    from PIL import Image
    w, h = img.size
    if max(w, h) > max_dim:
        s = max_dim / max(w, h)
        img = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
    bg = Image.new('RGB', img.size, (255, 255, 255))
    if img.mode == 'RGBA':
        bg.paste(img, mask=img.split()[3])
    else:
        bg.paste(img.convert('RGB'))
    buf = io.BytesIO()
    bg.save(buf, 'JPEG', quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


def process_psd(psd_bytes: bytes) -> dict:
    import psd_tools
    from PIL import Image
    import numpy as np

    tmp = tempfile.NamedTemporaryFile(suffix='.psd', delete=False)
    tmp.write(psd_bytes)
    tmp.close()
    try:
        psd = psd_tools.PSDImage.open(tmp.name)
    finally:
        os.unlink(tmp.name)

    W, H = psd.width, psd.height

    def composite_shirt(shirt_group_name, stamp_layer_name):
        main = find_nested(psd, 'Working Process', shirt_group_name, 'Objects', 'Main Object')
        if not main:
            main = find_nested(psd, 'Working Process', shirt_group_name, 'Main Object')
        if not main:
            return None

        canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))

        try:
            shirt_img = main.composite()
            if shirt_img:
                shirt_rgba = shirt_img.convert('RGBA')
                shirt_rgba = whiten_image(shirt_rgba)
                canvas.paste(shirt_rgba, (main.left, main.top), shirt_rgba)
        except Exception as e:
            print(f'Error compositing {shirt_group_name}: {e}')
            return None

        # Estampa (funciona con shapes Y pixels gracias a composite())
        stamp = find_layer(list(psd.layers), stamp_layer_name)
        if stamp:
            try:
                stamp_img = stamp.composite()
                if stamp_img:
                    stamp_rgba = stamp_img.convert('RGBA')
                    arr = np.array(stamp_rgba)
                    if (arr[:, :, 3] > 10).sum() > 50:
                        canvas.paste(stamp_rgba, (stamp.left, stamp.top), stamp_rgba)
            except Exception as e:
                print(f'Error compositing stamp {stamp_layer_name}: {e}')

        bbox = (main.left, main.top, main.right, main.bottom)
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            return canvas

        cropped = canvas.crop(bbox)
        result = Image.new('RGB', cropped.size, (255, 255, 255))
        result.paste(cropped, mask=cropped.split()[3])
        return result

    # Grifa
    grifa_b64 = None
    try:
        gl = find_layer(list(psd.layers), 'Grifa Frente')
        if gl:
            gi = gl.composite()
            if gi:
                arr = np.array(gi.convert('RGBA'))
                result_arr = np.zeros_like(arr)
                visible = arr[:, :, 3] > 50
                light   = arr[:, :, 0] > 128
                result_arr[visible] = [0, 0, 0, 255]
                result_arr[visible & light] = [255, 255, 255, 255]
                buf = io.BytesIO()
                Image.fromarray(result_arr).save(buf, 'PNG')
                grifa_b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        print(f'Grifa error: {e}')

    front_img = composite_shirt('Left Shirt',  'Estampa Frontal')
    back_img  = composite_shirt('Right Shirt', 'Estampa Espalda')

    return {
        'front': img_to_b64(front_img) if front_img else None,
        'back':  img_to_b64(back_img)  if back_img  else None,
        'grifa': grifa_b64,
    }
