"""
Vinted finto per le prove end-to-end: pagine HTML e API /api/v2 servite con
Playwright (context.route). Registra ogni richiesta per verificare che Vintory
resti in sola lettura.
NON è Vinted: le forme delle risposte seguono quelle note da Vinted_Relist e
Vintastic e le ipotesi documentate in src/content/vinted.js.
"""
import io, json, random, re
from urllib.parse import urlparse, parse_qs
from PIL import Image, ImageDraw

ORIGIN = "https://www.vinted.it"
ME = "4242"
OTHER = "77"
CDN = "https://images1.vinted.net"
ALLOWED_API = re.compile(r"^/api/v2/(items/\d+(/details)?|item_upload/items/\d+|wardrobe/\d+/items)$")
BRANDS = [(10, "Zara"), (11, "Levi's"), (12, "Nike"), (13, "H&M")]
SIZES = [(206, "S"), (207, "M"), (208, "L")]
STATUS = [(6, "Nuovo con cartellino"), (2, "Ottime"), (3, "Buone")]
COLORS = [(1, "Nero"), (9, "Blu"), (7, "Rosso"), (12, "Bianco")]
CATS = [(1904, ["Donna", "Vestiti"]), (1907, ["Donna", "Giacche"]), (2050, ["Uomo", "Scarpe"])]


def photo_bytes(pid: int) -> bytes:
    """JPEG diverso per ogni foto: l'impronta visiva deve distinguere le foto."""
    rnd = random.Random(pid)
    img = Image.new("RGB", (480, 640), (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    d = ImageDraw.Draw(img)
    for _ in range(14):
        x, y = rnd.randrange(480), rnd.randrange(640)
        d.rectangle([x, y, x + rnd.randrange(40, 240), y + rnd.randrange(40, 240)], fill=(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return buf.getvalue()


class FakeVinted:
    def __init__(self, mine=30, others=6):
        self.items = {}
        self.requests = []          # (method, path)
        self.fail = {}              # regex del percorso -> status (int) oppure "captcha"
        self.legacy_item_api = False
        self.photo_fail = set()
        self.logged_in = True
        for i in range(mine):
            self.add(900000 + i, ME, "masha_up", i)
        for i in range(others):
            self.add(700000 + i, OTHER, "venditrice_test", i + 3)

    def add(self, iid, uid, login, i, photos=5, **over):
        b, s, st, cat = BRANDS[i % 4], SIZES[i % 3], STATUS[i % 3], CATS[i % 3]
        c1, c2 = COLORS[i % 4], COLORS[(i + 1) % 4]
        titles = ["Giacca di jeans", "Vestito a fiori", "Scarpe da ginnastica", "Maglione di lana", "Borsa in pelle"]
        self.items[iid] = {
            "id": iid, "title": f"{titles[i % 5]} {i}", "description": f"Descrizione dell'articolo {i}.\nSpedizione veloce. Perché no?",
            "price": {"amount": f"{10 + i % 40}.0", "currency_code": "EUR"},
            "brand_dto": {"id": b[0], "title": b[1]}, "size_title": s[1], "status": st[1], "color1": c1[1], "color2": c2[1],
            "catalog_id": cat[0], "_crumbs": cat[1], "_ids": {"brand_id": b[0], "size_id": s[0], "status_id": st[0], "color_ids": [c1[0], c2[0]]},
            "path": f"/items/{iid}-articolo-{i}", "url": f"{ORIGIN}/items/{iid}-articolo-{i}",
            "user": {"id": int(uid), "login": login}, "created_at_ts": f"2026-10-{1 + i % 27:02d}T10:00:00+02:00",
            "is_closed": False, "is_reserved": False, "is_hidden": False,
            "photos": [self.photo(iid * 10 + k) for k in range(photos)],
        }
        self.items[iid].update(over)
        return self.items[iid]

    @staticmethod
    def photo(pid):
        return {"id": pid, "url": f"{CDN}/t/{pid}.jpg", "full_size_url": f"{CDN}/f/{pid}.jpg", "width": 480, "height": 640,
                "thumbnails": [{"type": "thumb310x430", "url": f"{CDN}/s/{pid}.jpg"}]}

    def public(self, it):
        return {k: v for k, v in it.items() if not k.startswith("_")}

    def upload_shape(self, it):
        d = {"id": it["id"], "title": it["title"], "description": it["description"], "price": it["price"]["amount"], "currency": "EUR",
             "catalog_id": it["catalog_id"], "user_id": it["user"]["id"], "photos": it["photos"], "is_unisex": False, "package_size_id": 2}
        d.update(it["_ids"])
        return d

    def row(self, it):
        return {"id": it["id"], "title": it["title"], "price": it["price"], "brand_title": it["brand_dto"]["title"], "size_title": it["size_title"], "status": it["status"],
                "path": it["path"], "url": it["url"], "user": it["user"], "photo": it["photos"][0] if it["photos"] else None, "is_closed": it["is_closed"], "is_reserved": it["is_reserved"], "is_hidden": it["is_hidden"]}

    # ------------------------------------------------------------------ pagine
    def item_html(self, it):
        ld = {"@context": "https://schema.org", "@type": "Product", "name": it["title"], "description": it["description"], "brand": {"@type": "Brand", "name": it["brand_dto"]["title"]},
              "image": [p["full_size_url"] for p in it["photos"]], "offers": {"@type": "Offer", "price": it["price"]["amount"], "priceCurrency": "EUR"}}
        crumbs = "".join(f'<li><a href="/catalog/{i}">{c}</a></li>' for i, c in enumerate(["Home"] + it["_crumbs"]))
        embedded = json.dumps({"item": {"id": it["id"], "user_id": it["user"]["id"]}})
        return f"""<!doctype html><html lang="it"><head><meta charset="utf-8"><title>{it['title']} | Vinted</title>
<meta name="csrf-token" content="csrf-token-di-prova-1234567890">
<meta property="og:title" content="{it['title']}"><script type="application/ld+json">{json.dumps(ld)}</script></head>
<body><header><a href="/member/{ME}">Il mio profilo</a><button data-testid="header-user-menu">menu</button></header>
<main><nav data-testid="breadcrumbs"><ol>{crumbs}</ol></nav><h1>{it['title']}</h1>
<div data-testid="item-attributes-brand"><span>Marca</span><span itemprop="brand">{it['brand_dto']['title']}</span></div>
<div data-testid="item-attributes-size"><span>Taglia</span><span>{it['size_title']}</span></div>
<div data-testid="item-attributes-status"><span>Condizioni</span><span>{it['status']}</span></div>
<div data-testid="item-attributes-color"><span>Colore</span><span>{it['color1']}, {it['color2']}</span></div>
<a href="/member/{it['user']['id']}-{it['user']['login']}">{it['user']['login']}</a></main>
<script>window.__DATA__ = {embedded};</script></body></html>"""

    def member_html(self, uid):
        cards = "".join(f'<div data-testid="grid-item"><a href="{it["path"]}"><img alt="{it["title"]}, prezzo" src="{it["photos"][0]["url"] if it["photos"] else ""}"></a><p>{it["price"]["amount"]} €</p></div>'
                        for it in self.items.values() if str(it["user"]["id"]) == str(uid))
        return f'<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Armadio | Vinted</title><meta name="csrf-token" content="csrf-token-di-prova-1234567890"></head><body><main>{cards}</main></body></html>'

    # ------------------------------------------------------------------ richieste
    async def handle(self, route):
        req = route.request
        u = urlparse(req.url)
        path = u.path
        self.requests.append((req.method, path))
        for pattern, status in self.fail.items():
            if re.search(pattern, path):
                if status == "captcha":
                    return await route.fulfill(status=403, content_type="text/html", body='<html><script src="https://geo.captcha-delivery.com/captcha/"></script></html>')
                return await route.fulfill(status=status, content_type="application/json", body=json.dumps({"message": f"errore {status}"}))

        async def js(data, status=200):
            await route.fulfill(status=status, content_type="application/json", body=json.dumps(data))

        if path.startswith("/api/"):
            if req.method != "GET" or not ALLOWED_API.match(path):
                return await js({"message": "non previsto"}, 400)
            m = re.match(r"^/api/v2/items/(\d+)/details$", path)
            if m:
                it = self.items.get(int(m.group(1)))
                return await js({"item": self.public(it)}) if it else await js({"message": "not found"}, 404)
            m = re.match(r"^/api/v2/items/(\d+)$", path)
            if m:
                it = self.items.get(int(m.group(1)))
                return await js({"item": self.public(it)}) if (it and self.legacy_item_api) else await js({"message": "not found"}, 404)
            m = re.match(r"^/api/v2/item_upload/items/(\d+)$", path)
            if m:
                it = self.items.get(int(m.group(1)))
                if it and self.logged_in and str(it["user"]["id"]) == ME:
                    return await js({"item": self.upload_shape(it)})
                return await js({"message": "not found"}, 404)
            m = re.match(r"^/api/v2/wardrobe/(\d+)/items$", path)
            if m:
                q = parse_qs(u.query)
                page, per = int(q.get("page", ["1"])[0]), int(q.get("per_page", ["96"])[0])
                rows = sorted([it for it in self.items.values() if str(it["user"]["id"]) == m.group(1)], key=lambda x: -x["id"])
                pages = max(1, -(-len(rows) // per))
                return await js({"items": [self.row(it) for it in rows[(page - 1) * per: page * per]], "pagination": {"current_page": page, "total_pages": pages, "total_entries": len(rows), "per_page": per}})
        m = re.match(r"^/items/(\d+)", path)
        if m:
            it = self.items.get(int(m.group(1)))
            if not it:
                return await route.fulfill(status=404, content_type="text/html", body="<html><body><main><h1>Pagina non trovata</h1></main></body></html>")
            return await route.fulfill(status=200, content_type="text/html", body=self.item_html(it))
        m = re.match(r"^/member/(\d+)", path)
        if m:
            return await route.fulfill(status=200, content_type="text/html", body=self.member_html(m.group(1)))
        await route.fulfill(status=200, content_type="text/html", body='<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Vinted</title><meta name="csrf-token" content="csrf-token-di-prova-1234567890"></head><body><main><h1>Vinted finto</h1></main></body></html>')

    async def handle_photo(self, route):
        path = urlparse(route.request.url).path
        self.requests.append((route.request.method, "cdn:" + path))
        m = re.search(r"/(\d+)\.jpg$", path)
        if not m or int(m.group(1)) in self.photo_fail:
            return await route.fulfill(status=404, body="")
        await route.fulfill(status=200, content_type="image/jpeg", body=photo_bytes(int(m.group(1))))

    def writes(self):
        return [r for r in self.requests if r[0] != "GET"]

    def unexpected_api(self):
        return [r for r in self.requests if r[1].startswith("/api/") and not ALLOWED_API.match(r[1])]
