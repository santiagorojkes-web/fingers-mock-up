# api/psd.py — Vercel Python function
# Procesa PSDs con psd-tools (shape layers, pixel layers, todo)
# Recibe el PSD como multipart/form-data directo (sin base64)

from http.server import BaseHTTPRequestHandler
import json, base64, io, os, tempfile, cgi

class handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self._headers(200)

    def do_POST(self):
        try:
            ct = self.headers.get('Content-Type','')
            cl = int(self.headers.get('Content-Length', 0))

            if 'multipart/form-data' in ct:
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={'REQUEST_METHOD':'POST','CONTENT_TYPE':ct,'CONTENT_LENGTH':str(cl)}
                )
                item = form['file'] if 'file' in form else None
                if not item:
                    return self._respond(400, {'error': 'No file'})
                psd_bytes = item.file.read()
            else:
                # fallback: raw body
                psd_bytes = self.rfile.read(cl)

            result = process_psd(psd_bytes)
            self._respond(200, result)

        except Exception as e:
            import traceback
            self._respond(500, {'error': str(e), 'trace': traceback.format_exc()})

    def _headers(self, code):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Access-Control-Allow-Methods','POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Content-Type')
        self.end_headers()

    def _respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type','application/json')
        self.send_header('Access-Control-Allow-Origin','*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self,*a): pass


def find_layer(layers, name):
    for l in layers:
        if l.name == name: return l
    return None

def find_nested(root, *path):
    cur = root
    for s in path:
        cur = find_layer(cur, s)
        if not cur: return None
    return cur

def whiten(arr):
    import numpy as np
    alpha = arr[:,:,3]
    for c in range(3):
        ch = arr[:,:,c].astype(float)
        m = (alpha>10) & (ch>120)
        if m.sum()>0:
            mn,mx = ch[m].min(), ch[m].max()
            ch[m] = 200 + (ch[m]-mn)/max(mx-mn,1)*55
        arr[:,:,c] = ch.astype('uint8')
    return arr

def img_to_b64(img, max_dim=1400, q=92):
    import io as _io
    w,h = img.size
    if max(w,h)>max_dim:
        s=max_dim/max(w,h)
        from PIL import Image
        img=img.resize((round(w*s),round(h*s)), Image.LANCZOS)
    rgb = __import__('PIL.Image',fromlist=['Image']).Image.new('RGB', img.size, (255,255,255))
    if img.mode=='RGBA': rgb.paste(img, mask=img.split()[3])
    else: rgb.paste(img)
    buf=_io.BytesIO()
    rgb.save(buf,'JPEG',quality=q)
    return base64.b64encode(buf.getvalue()).decode()

def process_psd(psd_bytes):
    import tempfile, os, numpy as np
    from PIL import Image
    import psd_tools

    # Write to temp file
    f = tempfile.NamedTemporaryFile(suffix='.psd', delete=False)
    f.write(psd_bytes); f.close()
    try:
        psd = psd_tools.PSDImage.open(f.name)
    finally:
        os.unlink(f.name)

    W,H = psd.width, psd.height

    def composite_shirt(shirt_name, stamp_name):
        main = find_nested(psd,'Working Process',shirt_name,'Objects','Main Object')
        if not main: return None
        canvas = Image.new('RGBA',(W,H),(0,0,0,0))
        shirt_img = main.topil().convert('RGBA')
        arr = np.array(shirt_img); arr=whiten(arr)
        shirt_w = Image.fromarray(arr)
        bx = main.bbox
        canvas.paste(shirt_w,(bx[0],bx[1]),shirt_w)
        stamp = find_layer(list(psd), stamp_name)
        if stamp:
            si = stamp.composite()
            if si:
                sa = np.array(si.convert('RGBA'))
                if (sa[:,:,3]>10).sum()>50:
                    sb = stamp.bbox
                    canvas.paste(si.convert('RGBA'),(sb[0],sb[1]),si.convert('RGBA'))
        return canvas.crop((bx[0],bx[1],bx[2],bx[3]))

    # Grifa
    grifa_b64 = None
    gl = find_layer(list(psd),'Grifa Frente')
    if gl:
        gi = gl.composite()
        if gi:
            arr = np.array(gi.convert('RGBA'))
            result = np.zeros_like(arr)
            label = arr[:,:,3]>50
            finger = arr[:,:,0]>128
            result[label]=[0,0,0,255]
            result[label&finger]=[255,255,255,255]
            buf=io.BytesIO()
            Image.fromarray(result).save(buf,'PNG')
            grifa_b64=base64.b64encode(buf.getvalue()).decode()

    front = composite_shirt('Left Shirt','Estampa Frontal')
    back  = composite_shirt('Right Shirt','Estampa Espalda')

    return {
        'front': img_to_b64(front) if front else None,
        'back':  img_to_b64(back)  if back  else None,
        'grifa': grifa_b64,
    }
