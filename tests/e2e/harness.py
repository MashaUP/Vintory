"""Avvio di Chrome con Vintory caricata e il Vinted finto."""
import asyncio, os, shutil, tempfile, time
from playwright.async_api import async_playwright
from fake_vinted import FakeVinted, ORIGIN, ME

EXT = os.environ.get("VINTORY_EXT") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))      # VINTORY_EXT: prova la cartella del pacchetto
CHROME = os.environ.get("CHROME_PATH") or shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser") or "/usr/bin/google-chrome"
os.environ.setdefault("PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS", "1")
READY = "() => !document.getElementById('app')?.hasAttribute('aria-busy')"
MODULES = "const archive = await import('/src/shared/archive.js'); const db = await import('/src/shared/db.js'); const store = await import('/src/shared/store.js');"


class Env:
    def __init__(self, pw, ctx, fake, profile):
        self.pw, self.ctx, self.fake, self.profile = pw, ctx, fake, profile
        self.errors = []
        self.ext = None
        self.ui = None
        self.github = None

    async def sw(self):
        for w in self.ctx.service_workers:
            if w.url.startswith("chrome-extension://"):
                return w
        return await self.ctx.wait_for_event("serviceworker", timeout=20000)

    def watch(self, page):
        page.on("pageerror", lambda e: self.errors.append(f"pageerror {page.url.split('/')[-1]}: {e}"))
        page.on("console", lambda m: self.errors.append(f"console.error {page.url.split('/')[-1]}: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)

    async def ext_page(self, path):
        page = await self.ctx.new_page()
        self.watch(page)
        for _ in range(20):
            try:
                await page.goto(f"chrome-extension://{self.ext}/{path}")
                if await page.evaluate("Boolean(globalThis.chrome && chrome.runtime && chrome.runtime.id)"):
                    return page
            except Exception:
                pass
            await asyncio.sleep(0.5)
        raise AssertionError(f"La pagina {path} dell'estensione non si è aperta")

    async def dash(self, route="archive"):
        if self.ui and not self.ui.is_closed():
            await self.ui.close()
        self.ui = await self.ext_page(f"src/ui/dashboard.html#{route}")
        await self.ui.wait_for_function(READY, timeout=20000)
        return self.ui

    async def go(self, route):
        await self.ui.bring_to_front()      # una scheda in secondo piano rallenta i clic di Playwright
        await self.ui.evaluate("(r) => { location.hash = r; }", route)
        await asyncio.sleep(0.15)
        await self.ui.wait_for_function(READY, timeout=20000)

    async def reload(self):
        await self.ui.reload()
        await self.ui.wait_for_function(READY, timeout=20000)

    async def rpc(self, method, params=None):
        r = await self.ui.evaluate("([m,p]) => chrome.runtime.sendMessage({type:'vy:rpc', method:m, params:p})", [method, params or {}])
        if isinstance(r, dict) and r.get("__error"):
            raise RuntimeError(f"{method}: {r['error']}")
        return r

    async def A(self, expr, arg=None):
        """Valuta un'espressione nella dashboard con i moduli archive, db e store."""
        return await self.ui.evaluate("async (arg) => { " + MODULES + " return await (" + expr + "); }", arg)

    async def listing(self, vinted_id):
        return await self.A("archive.findByVintedId(arg)", str(vinted_id))

    async def listings(self):
        return await self.A("archive.listAll()")

    async def settings(self, patch):
        await self.A("store.saveSettings(arg)", patch)

    async def vinted(self, path):
        page = await self.ctx.new_page()
        await page.goto(ORIGIN + path)
        return page

    async def tab_id(self, page):
        url = page.url
        tabs = await self.ui.evaluate("(u) => chrome.tabs.query({}).then((ts) => ts.filter((t) => t.url === u).map((t) => t.id))", url)
        return tabs[0]

    async def badge(self, page):
        return await self.ui.evaluate("(id) => chrome.action.getBadgeText({ tabId: id })", await self.tab_id(page))

    async def wait_for(self, fn, timeout=30, interval=0.3, what="condizione"):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            last = await fn()
            if last:
                return last
            await asyncio.sleep(interval)
        raise AssertionError(f"Tempo scaduto in attesa di: {what} (ultimo valore {last!r})")

    async def toast(self, text, timeout=20000):
        await self.ui.wait_for_function("(t) => [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes(t))", arg=text, timeout=timeout)

    async def close_modals(self):
        await self.ui.evaluate("() => document.querySelectorAll('.overlay, .lightbox').forEach((o) => o.remove())")


async def start(fake=None, profile=None):
    pw = await async_playwright().start()
    profile = profile or tempfile.mkdtemp(prefix="vy-e2e-")
    ctx = await pw.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True, accept_downloads=True,
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--headless=new", "--no-sandbox", "--no-first-run"])
    fake = fake or FakeVinted()
    await ctx.add_cookies([{"name": "v_uid", "value": ME, "domain": "www.vinted.it", "path": "/", "secure": True, "httpOnly": True}])
    await ctx.route("https://www.vinted.it/**", fake.handle)
    await ctx.route("https://images1.vinted.net/**", fake.handle_photo)
    env = Env(pw, ctx, fake, profile)

    async def gh(route):          # registrato all'avvio: le route aggiunte dopo non valgono per il service worker
        if env.github:
            return await env.github(route)
        return await route.fulfill(status=404, body="{}")
    for pattern in ("https://github.com/**", "https://raw.githubusercontent.com/**"):
        await ctx.route(pattern, gh)
    sw = await env.sw()
    env.ext = sw.url.split("/")[2]
    await asyncio.sleep(1.5)       # alla prima installazione si apre la scheda di benvenuto
    for p in ctx.pages:
        if p.url.startswith("chrome-extension://"):
            await p.close()
    return env


async def stop(env, keep_profile=False):
    try:
        try:
            await env.ctx.unroute_all(behavior="ignoreErrors")
        except Exception:
            pass
        await env.ctx.close()
    finally:
        await env.pw.stop()
        if not keep_profile:
            shutil.rmtree(env.profile, ignore_errors=True)
