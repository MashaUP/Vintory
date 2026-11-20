"""Google Drive finto per le prove: cartella appDataFolder, caricamento «resumable» a pezzi, elenco, download, eliminazione.
Accetta solo il token «tok-prova»: ogni altra richiesta riceve 401, come il Drive vero."""
import itertools, json, re, time
from urllib.parse import urlparse, parse_qs

TOKEN = "tok-prova"


class FakeDrive:
    def __init__(self):
        self.files = {}            # id → {name, data, created, appProperties}
        self.sessions = {}         # id sessione → {meta, data, total}
        self.ids = itertools.count(1)
        self.requests = []
        self.revoked = 0

    def listing(self):
        return sorted(self.files.values(), key=lambda f: f["created"], reverse=True)

    async def handle(self, route):
        req = route.request
        u = urlparse(req.url)
        q = parse_qs(u.query)
        self.requests.append((req.method, u.path))
        js = lambda obj, status=200, headers=None: route.fulfill(status=status, content_type="application/json", body=json.dumps(obj), headers=headers or {})
        if u.netloc == "oauth2.googleapis.com":
            self.revoked += 1
            return await js({})
        # sessione di caricamento: l'indirizzo è il permesso, come nel Drive vero
        if u.path == "/upload/drive/v3/files" and "upload_id" in q:
            s = self.sessions.get(q["upload_id"][0])
            if not s:
                return await js({"error": "no session"}, 404)
            body = req.post_data_buffer or b""
            m = re.match(r"bytes (\d+)-(\d+)/(\d+)", req.headers.get("content-range", ""))
            if m and int(m.group(1)) != len(s["data"]):
                return await route.fulfill(status=308, headers={"Range": f"bytes=0-{len(s['data']) - 1}"}, body="")
            s["data"] += body
            if len(s["data"]) < s["total"]:
                return await route.fulfill(status=308, headers={"Range": f"bytes=0-{len(s['data']) - 1}"}, body="")
            fid = f"f{next(self.ids)}"
            self.files[fid] = {"id": fid, "name": s["meta"]["name"], "data": bytes(s["data"]), "created": time.time() + len(self.files) * 0.001, "appProperties": s["meta"].get("appProperties", {}), "parents": s["meta"].get("parents")}
            del self.sessions[q["upload_id"][0]]
            return await js({"id": fid})
        if req.headers.get("authorization") != f"Bearer {TOKEN}":
            return await js({"error": {"code": 401}}, 401)
        if u.path == "/upload/drive/v3/files" and req.method == "POST" and q.get("uploadType") == ["resumable"]:
            sid = f"s{next(self.ids)}"
            self.sessions[sid] = {"meta": json.loads(req.post_data or "{}"), "data": bytearray(), "total": int(req.headers.get("x-upload-content-length", "0"))}
            return await js({}, 200, {"Location": f"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id={sid}"})
        if u.path == "/drive/v3/files" and req.method == "GET":
            files = [f for f in self.listing() if f.get("parents") == ["appDataFolder"]]
            return await js({"files": [{"id": f["id"], "name": f["name"], "size": str(len(f["data"])), "createdTime": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(f["created"])), "appProperties": f["appProperties"]} for f in files]})
        m = re.match(r"^/drive/v3/files/([\w-]+)$", u.path)
        if m:
            f = self.files.get(m.group(1))
            if not f:
                return await js({"error": "not found"}, 404)
            if req.method == "DELETE":
                del self.files[f["id"]]
                return await route.fulfill(status=204, body="")
            if q.get("alt") == ["media"]:
                return await route.fulfill(status=200, content_type="application/octet-stream", body=f["data"], headers={"Content-Length": str(len(f["data"]))})
        return await js({"error": "non previsto"}, 400)


def auth_flow_js(token=TOKEN):
    """Codice per sostituire la finestra di Google nelle prove: restituisce subito il token di prova."""
    return f"drive.setAuthFlowForTests(async (url) => {{ const u = new URL(url); if (!u.searchParams.get('client_id')) throw new Error('senza client'); return u.searchParams.get('redirect_uri') + '#access_token={token}&expires_in=3600&token_type=Bearer'; }})"
