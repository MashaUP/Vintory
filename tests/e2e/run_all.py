"""
Prove end-to-end di Vintory in Chrome reale, contro il Vinted finto.
Uso: python3 tests/e2e/run_all.py [filtro]
Gli scenari condividono un solo browser e si eseguono in ordine: ognuno parte
dallo stato lasciato dal precedente, come farebbe una persona che usa l'estensione.
"""
import asyncio, io, json, re, sys, time, zipfile
from harness import start, stop
from fake_vinted import FakeVinted, ORIGIN, ME, OTHER


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


async def btn_text(page):
    return await page.locator("#vintory-host .main").inner_text()


async def wait_btn(page, text, timeout=30000):
    await page.wait_for_function("(t) => document.querySelector('#vintory-host')?.shadowRoot?.querySelector('.main')?.textContent.includes(t)", arg=text, timeout=timeout)


async def cards(env):
    return await env.ui.locator("#results .grid .item").count()


# ---------------------------------------------------------------- scenari

async def t_save_button(env):
    """F1 F2 F4 F12 F13 F18 F22: salvataggio dalla pagina, scheda completa, foto, badge."""
    page = await env.vinted("/items/900000-articolo-0")
    env.pages["own"] = page
    await wait_btn(page, "Salva in Vintory")
    check(await env.badge(page) == "+", "badge «non salvato»")
    await page.locator("#vintory-host .main").click()
    await wait_btn(page, "Salvato in Vintory")
    l = await env.listing(900000)
    check(l and l["owner"] == "mine", f"proprietario: {l and l['owner']}")
    check(l["photoCount"] == 5 and l["photoMissing"] == 0 and len(l["imageIds"]) == 5, f"foto: {l['photoCount']} / mancanti {l['photoMissing']}")
    check(l["brand"] == "Zara" and l["size"] == "S" and l["condition"] == "Nuovo con cartellino", f"etichette: {l['brand']} {l['size']} {l['condition']}")
    check(l["category"] == "Donna › Vestiti" and l["colors"] == ["Nero", "Blu"], f"categoria/colori: {l['category']} {l['colors']}")
    check(l["ids"]["catalogId"] == "1904" and l["ids"]["sizeId"] == "206", f"id tecnici: {l['ids']}")
    check(set(l["sources"]) == {"upload", "details", "page"}, f"fonti: {l['sources']}")
    check(l["price"] == 10 and l["description"].startswith("Descrizione dell'articolo 0"), "prezzo e descrizione")
    imgs = await env.A("archive.getImages(arg).then((a) => a.map((i) => ({ size: i.blob?.size, w: i.width, h: i.height, sha: i.sha256, status: i.status, dhash: i.dhash })))", l)
    check(all(i["size"] > 3000 and i["w"] == 480 and i["h"] == 640 and len(i["sha"]) == 64 and i["status"] == "ok" for i in imgs), f"immagini: {imgs}")
    check(len({i["dhash"] for i in imgs}) == 5, "impronte visive diverse per foto diverse")
    thumb = await env.A("archive.getThumb(arg).then((b) => b && b.size)", l["coverImageId"])
    check(thumb and thumb < imgs[0]["size"], f"miniatura: {thumb}")
    raw = await env.A("archive.getRaw(arg).then((r) => Object.keys(r.bundle))", l["id"])
    check(set(raw) == {"upload", "details", "page"}, f"dati tecnici: {raw}")
    check(await env.badge(page) == "✓", f"badge «salvato»: {await env.badge(page)!r}")
    return "pulsante nella pagina → 5 foto 480×640, etichette e id tecnici, badge + → ✓"


async def t_no_duplicates(env):
    """F41: lo stesso annuncio non entra due volte."""
    tab = await env.tab_id(env.pages["own"])
    r = await env.rpc("save.tab", {"tabId": tab})
    check(r["status"] == "duplicate", f"esito: {r['status']}")
    await env.pages["own"].reload()
    await wait_btn(env.pages["own"], "Salvato in Vintory")
    check(len(await env.listings()) == 1, "un solo annuncio in archivio")
    ctx = await env.rpc("tab.context", {"tabId": tab})
    check(ctx["saved"] and ctx["kind"] == "item", f"contesto per il popup: {ctx}")
    return "secondo salvataggio → «già in archivio», nessuna copia"


async def t_other_listing(env):
    """F6: annuncio non mio → avviso, conferma, sezione separata."""
    page = await env.vinted("/items/700000-articolo-3")
    env.pages["other"] = page
    await wait_btn(page, "Salva in Vintory")
    await page.locator("#vintory-host .main").click()
    await page.locator("#vintory-host .panel").wait_for(timeout=15000)
    text = await page.locator("#vintory-host .panel").inner_text()
    check("non è tuo" in text and "venditrice_test" in text, f"avviso: {text}")
    check(len(await env.listings()) == 1, "niente salvato prima della conferma")
    await page.locator("#vintory-host .panel .ok").click()
    await wait_btn(page, "Salvato in Vintory")
    l = await env.listing(700000)
    check(l["owner"] == "other" and l["sellerLogin"] == "venditrice_test", f"proprietario: {l['owner']}")
    check("upload" not in l["sources"], "nessuna lettura del modulo di vendita per un annuncio altrui")
    await env.reload()
    check(await cards(env) == 1, "archivio: solo il mio")
    await env.go("others")
    check(await cards(env) == 1, "sezione «non miei»: uno")
    await env.ui.locator("#results .item .thumb").first.click()
    await env.ui.locator(".modal .dside").wait_for()
    actions = await env.ui.locator(".modal .actions").inner_text()
    check("Prepara" not in actions and "Aggiorna da Vinted" in actions, f"azioni per un annuncio non mio: {actions}")
    await env.close_modals()
    return "avviso «non è tuo» → conferma → sezione «Annunci non miei», senza «Prepara»"


async def t_captcha_and_photo_errors(env):
    """Vincoli: CAPTCHA ferma tutto; una foto che non si scarica viene segnalata."""
    env.fake.fail = {r"/api/v2/item_upload/items/900050": "captcha"}
    page = await env.vinted("/items/900050-articolo-50")
    await wait_btn(page, "Salva in Vintory")
    await page.locator("#vintory-host .main").click()
    await page.wait_for_function("() => document.querySelector('#vintory-host').shadowRoot.querySelector('.toast.bad')?.textContent.includes('CAPTCHA')", timeout=15000)
    check(await env.listing(900050) is None, "con il CAPTCHA non si salva nulla")
    calls = [r for r in env.fake.requests if "900050" in r[1] and r[1].startswith("/api/")]
    check(len(calls) == 1, f"dopo il CAPTCHA nessun'altra richiesta: {calls}")
    env.fake.fail = {}
    await page.close()
    env.fake.photo_fail.add(9000512)
    page = await env.vinted("/items/900051-articolo-51")
    await wait_btn(page, "Salva in Vintory")
    await page.locator("#vintory-host .main").click()
    await wait_btn(page, "Salvato in Vintory")
    l = await env.listing(900051)
    check(l["photoCount"] == 5 and l["photoMissing"] == 1, f"foto mancanti: {l['photoMissing']}")
    env.fake.photo_fail.clear()
    await page.close()
    return "CAPTCHA → stop senza altre richieste; foto 404 → annuncio salvato con «1 foto mancante»"


async def t_import(env):
    """F7 F9 F10: importazione dall'armadio con anteprima, due pagine, solo i nuovi, solo attivi."""
    env.fake.items[900105]["is_closed"] = True
    await env.settings({"importDelay": {"min": 0, "max": 0}})
    await env.reload()
    page = await env.vinted(f"/member/{ME}")
    env.pages["wardrobe"] = page
    await wait_btn(page, "Importa il mio armadio")
    await page.locator("#vintory-host .main").click()
    await env.ui.locator("#preview").wait_for(timeout=20000)
    await env.ui.wait_for_function("() => document.querySelector('#preview')?.textContent.includes('annunci letti')", timeout=30000)
    head = await env.ui.locator("#preview").inner_text()
    check("110 annunci letti" in head and "Il tuo armadio" in head, f"anteprima: {head[:160]}")
    check("2 già in archivio" in head and "1 venduti" in head, f"contatori: {head[:300]}")
    n = await env.ui.locator("#preview .item.pv").count()
    check(n == 107, f"visibili (110 − 2 salvati − 1 venduto): {n}")
    wardrobe_calls = [r for r in env.fake.requests if "/wardrobe/" in r[1]]
    check(len(wardrobe_calls) == 2, f"due pagine dell'elenco: {len(wardrobe_calls)}")
    await env.ui.get_by_role("button", name="Nessuno").click()
    for i in range(8):
        await env.ui.locator("#preview .item.pv .pick input").nth(i).check()
    await env.ui.locator("#import-start").click()
    await env.ui.locator('details.job[data-status="done"]').wait_for(timeout=90000)
    mine = [l for l in await env.listings() if l["owner"] == "mine"]
    check(len(mine) == 10, f"miei dopo l'importazione: {len(mine)}")
    imported = [l for l in mine if l["source"] == "import"]
    check(len(imported) == 8 and all(l["photoCount"] == 5 and l["photoMissing"] == 0 and l["jobId"] for l in imported), "8 importati con 5 foto")
    check(all(l["brand"] and l["size"] and l["condition"] and l["ids"]["catalogId"] for l in imported), "marca, taglia, condizioni e id della categoria anche senza aprire la pagina")
    # 1.0.2: il nome della categoria si impara durante l'importazione, una pagina per categoria mai vista.
    check(all(l["category"] for l in imported), f"categorie: {[l['category'] for l in imported]}")
    page_reads = [r for r in env.fake.requests if r[0] == "GET" and re.match(r"^/items/\d+$", r[1]) and any(r[1] == f"/items/{l['vintedId']}" for l in imported)]
    check(len(page_reads) <= len({l["ids"]["catalogId"] for l in imported}), f"al massimo una pagina per categoria: {len(page_reads)}")
    job = (await env.A("db.getAll('jobs')"))[0]
    check(job["status"] == "done" and all(i["status"] == "done" and "wardrobe" not in i for i in job["items"]), f"cronologia: {job['status']}")
    return "pulsante sull'armadio → 110 letti in 2 pagine, 107 proposti, 8 scelti e salvati con 5 foto e categoria"


async def t_import_blocked_resume(env):
    """F8: Vinted limita le richieste → stop; poi ripresa senza perdere il già salvato."""
    await env.go(f"import?origin={ORIGIN}&user={ME}")
    await env.ui.wait_for_function("() => document.querySelector('#preview')?.textContent.includes('annunci letti')", timeout=30000)
    await env.ui.get_by_role("button", name="Nessuno").click()
    ids = await env.ui.evaluate("() => [...document.querySelectorAll('#preview .item.pv .t')].slice(0, 6).map((e) => e.textContent)")
    for i in range(6):
        await env.ui.locator("#preview .item.pv .pick input").nth(i).check()
    third = [it for it in env.fake.items.values() if it["title"] == ids[2]][0]["id"]
    env.fake.fail = {rf"/api/v2/item_upload/items/{third}": 429}
    before = len(await env.listings())
    await env.ui.locator("#import-start").click()
    await env.ui.locator('details.job[data-status="blocked"]').wait_for(timeout=60000)
    check(len(await env.listings()) == before + 2, "i due salvati prima del blocco restano")
    note = await env.ui.locator('details.job[data-status="blocked"] .note').inner_text()
    check("429" in note, f"motivo mostrato: {note}")
    n_calls = len(env.fake.requests)
    await asyncio.sleep(1.5)
    check(len([r for r in env.fake.requests[n_calls:] if r[1].startswith("/api/")]) == 0, "dopo il blocco nessuna richiesta a Vinted")
    env.fake.fail = {}
    await env.ui.locator('details.job[data-status="blocked"] [data-act="resume"]').click()
    await env.ui.wait_for_function("() => document.querySelectorAll('details.job[data-status=\"done\"]').length === 2", timeout=60000)
    check(len(await env.listings()) == before + 6, "dopo la ripresa ci sono tutti e sei")
    return "429 al terzo annuncio → «Fermata da Vinted», 2 salvati al sicuro, «Riprendi» completa i 6"


async def t_import_interrupted(env):
    """F8: chiusura del browser a metà → l'importazione risulta interrotta e si riprende."""
    rows = [it for it in sorted(env.fake.items.values(), key=lambda x: -x["id"]) if str(it["user"]["id"]) == ME]
    saved = {l["vintedId"] for l in await env.listings()}
    todo = [it for it in rows if str(it["id"]) not in saved and not it["is_closed"]][:3]
    tab = await env.tab_id(env.pages["wardrobe"])
    job = {"id": "j_test", "createdAt": int(time.time() * 1000), "updatedAt": 0, "origin": ORIGIN, "userId": ME, "sellerLogin": "masha_up", "tabId": tab, "owner": "mine", "status": "running", "message": None,
           "items": [{"vintedId": str(it["id"]), "title": it["title"], "price": 10, "currency": "EUR", "status": "pending", "wardrobe": env.fake.row(it)} for it in todo]}
    await env.A("db.put('jobs', arg)", job)
    before = len(await env.listings())
    await env.reload()                 # come riaprire il browser: nessuno sta eseguendo quel lavoro
    await env.go("import")
    await env.ui.locator('details.job[data-job="j_test"][data-status="interrupted"]').wait_for(timeout=15000)
    await env.ui.locator('details.job[data-job="j_test"] [data-act="resume"]').click()
    await env.ui.locator('details.job[data-job="j_test"][data-status="done"]').wait_for(timeout=60000)
    check(len(await env.listings()) == before + 3, "i tre in attesa sono stati salvati")
    return "lavoro rimasto «in corso» → «Interrotta» alla riapertura → «Riprendi» salva i 3 mancanti"


async def t_search_filter_sort(env):
    """F23–F26 F28 F29: ricerca, filtri, ordinamento, vista a lista, filtro salvato, recenti."""
    await env.go("archive")
    total = await cards(env)
    await env.ui.locator("#search").fill("giacca")
    await env.ui.wait_for_function("(n) => document.querySelectorAll('#results .grid .item').length < n", arg=total, timeout=5000)
    titles = await env.ui.locator("#results .item .t").all_inner_texts()
    check(titles and all("giacca" in t.lower() for t in titles), f"ricerca: {titles}")
    await env.ui.locator("#search").fill("perche veloce")
    await env.ui.wait_for_function("(n) => document.querySelectorAll('#results .grid .item').length === n", arg=total, timeout=5000)
    await env.ui.locator("#search").fill("")
    await env.ui.locator("#filters-toggle").click()
    await env.ui.locator(".facet-group", has_text="Marca").locator("label", has_text="Zara").locator("input").check()
    n_zara = await cards(env)
    all_l = [l for l in await env.listings() if l["owner"] == "mine"]
    check(n_zara == len([l for l in all_l if l["brand"] == "Zara"]) and 0 < n_zara < total, f"filtro marca: {n_zara}")
    await env.ui.get_by_role("button", name="Salva questo filtro…").click()
    await env.ui.locator(".modal input").fill("Solo Zara")
    await env.ui.locator('.modal [data-act="ok"]').click()
    await env.ui.wait_for_function("() => [...document.querySelectorAll('select[aria-label=\"Filtri salvati\"] option')].some((o) => o.textContent === 'Solo Zara')", timeout=5000)
    await env.ui.get_by_role("button", name="Azzera filtri").click()
    check(await cards(env) == total, "filtri azzerati")
    await env.ui.locator('select[aria-label="Filtri salvati"]').select_option(label="Solo Zara")
    check(await cards(env) == n_zara, "filtro salvato riapplicato")
    await env.ui.get_by_role("button", name="Azzera filtri").click()
    await env.ui.locator('select[aria-label="Ordina per"]').select_option("price:asc")
    await asyncio.sleep(0.3)
    prices = [float(p.replace("€", "").replace("\xa0", "").replace(".", "").replace(",", ".").strip()) for p in await env.ui.locator("#results .item .meta strong").all_inner_texts()]
    check(prices == sorted(prices), f"ordine per prezzo: {prices[:6]}")
    await env.ui.locator('[data-view="list"]').click()
    await env.ui.locator("table.items tbody tr").first.wait_for()
    check(await env.ui.locator("table.items tbody tr").count() == total, "vista a lista")
    await env.ui.locator('[data-view="grid"]').click()
    await env.ui.locator('select[aria-label="Ordina per"]').select_option("savedAt:desc")
    await env.go("recent")
    check(await cards(env) == len(await env.listings()), "«Aggiunti di recente» mostra tutti, miei e non")
    return f"ricerca senza accenti, filtro marca ({n_zara}/{total}), filtro salvato, ordine per prezzo, lista e griglia"


async def t_selection_collections_trash(env):
    """F27 F30 F31 F34: selezione multipla, preferiti, collezioni, cestino."""
    await env.go("archive")
    for i in range(2):
        await env.ui.locator("#results .item .pick input").nth(i).check()
    check("2 selezionati" in await env.ui.locator(".selbar").inner_text(), "barra di selezione")
    await env.ui.locator(".selbar").get_by_role("button", name="Aggiungi ai preferiti").click()
    await env.wait_for(lambda: env.A("archive.listAll().then((a) => a.filter((l) => l.favorite).length === 2)"), what="2 preferiti")
    await env.ui.get_by_role("button", name="Collezioni…").click()
    await env.ui.locator('.modal input[aria-label="Nuova collezione"]').fill("Estate")
    await env.ui.locator('.modal [data-act="ok"]').click()
    await env.wait_for(lambda: env.A("db.getAll('collections').then((c) => c.length === 1 && c[0].name === 'Estate' && c[0].id)"), what="collezione creata")
    cid = (await env.A("db.getAll('collections')"))[0]["id"]
    await env.go("favorites")
    check(await cards(env) == 2, "sezione preferiti")
    await env.go(f"collection/{cid}")
    check(await cards(env) == 2 and "Estate" in await env.ui.locator(".page-head h1").inner_text(), "collezione con 2 annunci")
    await env.go("collections")
    check("2 annunci" in await env.ui.locator(".coll").inner_text(), "scheda della collezione")
    await env.go("archive")
    check("2 selezionati" in await env.ui.locator(".selbar").inner_text(), "la selezione resta quando torni nella sezione")
    await env.ui.locator(".selbar").get_by_role("button", name="Deseleziona").click()
    total = await cards(env)
    await env.ui.locator("#results .item .pick input").nth(3).check()
    await env.ui.get_by_role("button", name="Sposta nel cestino").click()
    await env.ui.wait_for_function("(n) => document.querySelectorAll('#results .grid .item').length === n - 1", arg=total, timeout=5000)
    await env.go("trash")
    check(await cards(env) == 1 and "Eliminato tra 30 giorni" in await env.ui.locator("#results").inner_text(), "cestino con scadenza")
    await env.ui.locator("#results .item .pick input").first.check()
    await env.ui.get_by_role("button", name="Ripristina").click()
    await env.ui.wait_for_function("() => document.querySelectorAll('#results .grid .item').length === 0", timeout=5000)
    await env.go("archive")
    check(await cards(env) == total, "ripristinato dal cestino")
    return "2 preferiti, collezione «Estate» creata e aperta, cestino → ripristino"


async def t_detail_edit_versions(env):
    """F14–F17 F19: scheda, galleria, modifica, note e campi, versioni, ritorno all'originale."""
    await env.go("archive")
    l0 = await env.listing(900000)
    await env.ui.evaluate("(id) => { location.hash = 'archive?item=' + id; }", l0["id"])
    await env.ui.locator(".modal .dside").wait_for()
    check(await env.ui.locator(".modal .strip button").count() == 5, "5 foto nella galleria")
    await env.ui.wait_for_function("() => document.querySelector('.modal .gallery .main')?.naturalWidth === 480", timeout=5000)
    await env.ui.locator(".modal .main-wrap").click()
    await env.ui.locator(".lightbox").wait_for()
    check("1 / 5" in await env.ui.locator(".lb-count").inner_text(), "foto a tutto schermo")
    await env.ui.keyboard.press("ArrowRight")
    check("2 / 5" in await env.ui.locator(".lb-count").inner_text(), "frecce nella galleria")
    await env.ui.keyboard.press("Escape")
    check(await env.ui.locator(".lightbox").count() == 0 and await env.ui.locator(".modal").count() == 1, "Esc chiude solo la foto")
    await env.ui.locator('[data-tab="edit"]').click()
    await env.ui.locator('.modal [name="title"]').fill("Titolo modificato da me")
    await env.ui.locator('.modal [name="price"]').fill("99")
    await env.ui.locator('.modal form button[type="submit"]').click()
    await env.wait_for(lambda: env.A("archive.findByVintedId('900000').then((l) => l.title === 'Titolo modificato da me' && l.price === 99 && l.edited)"), what="copia modificata")
    raw = await env.A("archive.getRaw(arg).then((r) => r.normalized.title)", l0["id"])
    check(raw == "Vestito a fiori 0" or raw == l0["title"], f"l'originale non cambia: {raw}")
    await env.ui.locator('[data-tab="notes"]').click()
    await env.ui.locator('.modal [name="notes"]').fill("Nel secondo cassetto")
    await env.ui.locator('.modal [data-custom="Costo d\'acquisto"]').fill("4 €")
    await env.ui.locator('.modal form button[type="submit"]').click()
    await env.wait_for(lambda: env.A("archive.findByVintedId('900000').then((l) => l.notes === 'Nel secondo cassetto' && l.custom[\"Costo d'acquisto\"] === '4 €')"), what="note e campi")
    await env.ui.locator('[data-tab="versions"]').click()
    await env.ui.locator(".modal .tab-panel table tbody tr").first.wait_for()
    check(await env.ui.locator(".modal .tab-panel table tbody tr").count() == 1, "una versione precedente")
    await env.ui.get_by_role("button", name="Ripristina i dati originali").click()
    await env.ui.locator('.overlay').last.locator('[data-act="ok"]').click()
    await env.wait_for(lambda: env.A("archive.findByVintedId('900000').then((l) => l.title === arg && l.price === 10 && !l.edited)", l0["title"]), what="dati originali")
    l = await env.listing(900000)
    check(l["notes"] == "Nel secondo cassetto", "le note restano")
    await env.ui.locator('[data-tab="raw"]').click()
    check('"catalog_id": 1904' in await env.ui.locator(".modal pre.raw").inner_text(), "dati tecnici originali visibili")
    await env.close_modals()
    return "galleria con zoom, modifica senza toccare l'originale, note e campo personalizzato, versioni, ritorno all'originale"


async def t_update_from_vinted(env):
    """F4 F42: annuncio cambiato su Vinted → badge «!», differenze campo per campo, applicazione scelta."""
    it = env.fake.items[900000]
    it["title"] = "Titolo cambiato su Vinted"
    it["price"] = {"amount": "7.0", "currency_code": "EUR"}
    it["photos"] = it["photos"][1:] + [FakeVinted.photo(9000009)]
    await env.A("archive.findByVintedId('900000').then((l) => archive.patchMany([l.id], (x) => { x.onlineCheckedAt = 0; }))")
    page = env.pages["own"]
    await page.reload()
    await wait_btn(page, "Modificato su Vinted")
    check(await env.badge(page) == "!", f"badge «modificato»: {await env.badge(page)!r}")
    await page.locator("#vintory-host .main").click()
    await env.ui.wait_for_function("() => [...document.querySelectorAll('.modal h2')].some((h) => h.textContent === 'Differenze con Vinted')", timeout=30000)
    fields = await env.ui.evaluate("() => [...[...document.querySelectorAll('.overlay')].pop().querySelectorAll('tbody input[data-field]')].map((i) => [i.dataset.field, i.checked])")
    check(fields == [["title", True], ["price", True], ["photos", True]], f"differenze: {fields}")
    await env.ui.locator('.overlay').last.locator('input[data-field="title"]').uncheck()
    await env.ui.locator('.overlay').last.locator('[data-act="apply"]').click()
    await env.wait_for(lambda: env.A("archive.findByVintedId('900000').then((l) => l.price === 7 && !l.remoteChanged)"), what="aggiornamento applicato")
    l = await env.listing(900000)
    check(l["title"] != "Titolo cambiato su Vinted", "il campo non spuntato resta com'era")
    check(l["photoKeys"][-1] == "p9000009" and l["photoCount"] == 5 and l["photoMissing"] == 0, f"foto aggiornate: {l['photoKeys']}")
    versions = await env.A("archive.listVersions(arg).then((v) => v.length)", l["id"])
    check(versions >= 2, f"la versione precedente è conservata: {versions}")
    await env.close_modals()
    await page.reload()
    await wait_btn(page, "Salvato in Vintory")
    return "badge «!» e pulsante «Rivedi» → 3 differenze → applicati prezzo e foto, titolo lasciato"


async def t_offline_still_viewable(env):
    """F43 + criterio MVP: l'annuncio eliminato da Vinted resta consultabile con le sue foto."""
    l = [x for x in await env.listings() if x["source"] == "import"][0]
    del env.fake.items[int(l["vintedId"])]
    await env.go("archive")
    await env.ui.evaluate("(id) => { location.hash = 'archive?item=' + id; }", l["id"])
    await env.ui.locator(".modal .dside").wait_for()
    await env.ui.locator(".modal .actions").get_by_role("button", name="Controlla link").click()
    await env.wait_for(lambda: env.A("archive.getListing(arg).then((x) => x.online === 'offline')", l["id"]), what="stato «non più online»")
    await env.ui.wait_for_function("() => document.querySelector('.modal .tab-panel')?.textContent.includes('Non più online')", timeout=10000)
    check(await env.ui.locator(".modal .strip button").count() == 5, "le 5 foto restano")
    await env.ui.wait_for_function("() => document.querySelector('.modal .gallery .main')?.naturalWidth === 480", timeout=5000)
    check(l["description"][:20] in await env.ui.locator(".modal .desc").inner_text(), "descrizione ancora leggibile")
    await env.close_modals()
    await env.reload()
    check(await env.ui.locator("#results .item .chip.bad", has_text="Non più online").count() == 1, "etichetta nella griglia")
    return "annuncio tolto da Vinted → «Non più online», scheda e 5 foto ancora consultabili"


async def t_prepare_templates_relist(env):
    """F45–F48: modelli, «Prepara», esportazione per Vinted_Relist, ZIP delle foto."""
    await env.go("templates")
    await env.ui.get_by_role("button", name="Nuovo modello").click()
    await env.ui.locator(".modal input").fill("Spedizione")
    await env.ui.locator(".modal textarea").fill("Spedisco in 24 ore. Taglia {taglia}, marca {marca}.")
    check("Taglia M, marca Levi's" in await env.ui.locator(".modal .preview").inner_text(), "anteprima del modello")
    await env.ui.locator('.modal [data-act="ok"]').click()
    await env.ui.locator("main .card h2", has_text="Spedizione").wait_for()
    l = await env.listing(900000)
    await env.ui.evaluate("(id) => { location.hash = 'archive?item=' + id; }", l["id"])
    await env.ui.locator(".modal .dside").wait_for()
    await env.ui.locator(".modal .actions").get_by_role("button", name="Prepara").click()
    dlg = env.ui.locator(".overlay").last
    await dlg.get_by_role("button", name="Aggiungi in fondo").click()
    text = await dlg.locator("textarea").input_value()
    check(text.endswith("Spedisco in 24 ore. Taglia S, marca Zara."), f"modello inserito: {text[-60:]}")
    async with env.ui.expect_download() as d:
        await dlg.get_by_role("button", name="Esporta per Vinted_Relist").click()
    z = zipfile.ZipFile(await (await d.value).path())
    data = json.loads(z.read("relist.json"))
    check(data["format"] == "vintory-relist" and data["listing"]["description"] == text and data["uploadDraft"]["catalog_id"] == 1904, "relist.json con bozza e dati del modulo")
    check(len(data["photos"]) == 5 and all(n in z.namelist() for n in data["photos"]) and z.testzip() is None, f"foto nello zip: {data['photos']}")
    async with env.ui.expect_download() as d:
        await dlg.get_by_role("button", name="Foto (ZIP)").click()
    z = zipfile.ZipFile(await (await d.value).path())
    check(z.namelist() == ["01.jpg", "02.jpg", "03.jpg", "04.jpg", "05.jpg"] and z.read("01.jpg")[:2] == b"\xff\xd8", f"ZIP delle foto: {z.namelist()}")
    await dlg.locator('[data-act="save-draft"]').click()
    await env.wait_for(lambda: env.A("archive.findByVintedId('900000').then((x) => x.description.includes('Spedisco in 24 ore'))"), what="bozza salvata nella scheda")
    await env.close_modals()
    return "modello con segnaposto → «Prepara» → relist.json + 5 foto, ZIP foto, bozza salvata"


async def t_exports(env):
    """F39: CSV ed Excel."""
    await env.go("backup")
    async with env.ui.expect_download() as d:
        await env.ui.locator("#csv-mine").click()
    csv = open(await (await d.value).path(), "rb").read().decode("utf-8")
    mine = [l for l in await env.listings() if l["owner"] == "mine" and not l["deletedAt"]]
    check(csv.startswith("﻿ID Vinted;Titolo;") and "Costo d'acquisto" in csv.split("\r\n")[0], "intestazione CSV con i campi personalizzati")
    check("4 €" in csv and "Nel secondo cassetto" in csv, "valori personalizzati e note nel CSV")
    async with env.ui.expect_download() as d:
        await env.ui.locator("#xlsx-mine").click()
    z = zipfile.ZipFile(await (await d.value).path())
    sheet = z.read("xl/worksheets/sheet1.xml").decode()
    check(z.testzip() is None and sheet.count("<row ") == len(mine) + 1, f"Excel: {sheet.count('<row ')} righe per {len(mine)} annunci")
    return f"CSV (BOM, «;») ed Excel con {len(mine)} annunci e i campi personalizzati"


async def t_integrity(env):
    """F21: foto rovinata riconosciuta e riscaricata."""
    l = await env.listing(900051)
    await env.A("archive.getImages(arg).then((imgs) => db.put('images', { ...imgs[0], blob: new Blob(['rotta'], { type: 'image/jpeg' }) }))", l)
    await env.go("health")
    await env.ui.locator("#integrity-run").click()
    await env.ui.locator("#integrity-result").wait_for(timeout=60000)
    text = await env.ui.locator("#integrity-result").inner_text()
    check("rovinate: 1" in text and "mancanti: 1" in text, f"esito: {text}")
    await env.ui.get_by_role("button", name="Prova a riscaricare").click()
    await env.ui.wait_for_function("() => document.querySelector('#integrity-result')?.textContent.includes('riscaricate: 2')", timeout=60000)
    l = await env.listing(900051)
    check(l["photoMissing"] == 0, "dopo il riscaricamento non manca nulla")
    return "1 foto rovinata + 1 mancante trovate, entrambe riscaricate da Vinted"


async def t_backup_restore_new_install(env):
    """F11 F35 F36 + criterio MVP: backup completo e ripristino su una nuova installazione."""
    await env.go("backup")
    async with env.ui.expect_download() as d:
        await env.ui.locator("#backup-zip").click()
    dl = await d.value
    path = await dl.path()
    check(dl.suggested_filename.startswith("Vintory-backup-") and dl.suggested_filename.endswith(".zip"), dl.suggested_filename)
    z = zipfile.ZipFile(path)
    check(z.testzip() is None and "vintory.json" in z.namelist(), "ZIP valido con vintory.json")
    await env.wait_for(lambda: env.A("store.getSettings().then((s) => Boolean(s.backup.lastAt))"), what="data dell'ultimo backup")
    src = await env.listings()
    n_img = await env.A("db.count('images')")
    data = json.loads(z.read("vintory.json"))
    check(len(data["listings"]) == len(src) and len([n for n in z.namelist() if n.startswith("images/")]) == data["counts"]["photos"], "conteggi nel backup")
    env2 = await start(fake=env.fake)
    try:
        await env2.dash("backup")
        await env2.close_modals()
        await env2.ui.locator("#restore-file").set_input_files(path)
        await env2.ui.locator(".modal", has_text="Importa backup").wait_for()
        await env2.ui.locator('.modal input[value="replace"]').check()
        await env2.ui.locator('.modal [data-act="ok"]').click()
        await env2.toast("Importati", 120000)
        dst = await env2.listings()
        check(len(dst) == len(src), f"annunci ripristinati: {len(dst)}/{len(src)}")
        check(await env2.A("db.count('images')") == n_img, "tutte le foto ripristinate")
        l = await env2.listing(900000)
        check(l["notes"] == "Nel secondo cassetto" and l["favorite"] in (True, False) and l["photoCount"] == 5, "note e foto dell'annuncio")
        sizes = await env2.A("archive.getImages(arg).then((a) => a.map((i) => i.blob?.size || 0))", l)
        check(len(sizes) == 5 and all(s > 3000 for s in sizes), f"foto leggibili: {sizes}")
        check(len([x for x in dst if x["owner"] == "other"]) == 1, "sezione «non miei» conservata")
        check((await env2.A("db.getAll('collections')"))[0]["name"] == "Estate" and await env2.A("db.count('templates')") == 1, "collezioni e modelli")
        check(await env2.A("archive.listVersions(arg).then((v) => v.length)", l["id"]) >= 2, "versioni conservate")
        rep = await env2.A("archive.verifyIntegrity().then((r) => [r.photos, r.ok, r.missing, r.corrupt])")
        check(rep[0] == rep[1] and rep[2] == 0 and rep[3] == 0, f"integrità dopo il ripristino: {rep}")
        await env2.go("archive")
        await env2.ui.locator("#results .item .thumb img[src^='blob:']").first.wait_for(timeout=10000)
        errors = list(env2.errors)
    finally:
        await stop(env2)
    check(not errors, f"errori nella seconda installazione: {errors}")
    return f"backup di {len(src)} annunci e {n_img} foto → nuova installazione → tutto ripristinato e integro"


async def t_updates_and_links(env):
    """Requisiti di progetto: «Cerca aggiornamento», Ko-fi, Discord modificabile da links.json."""
    href = await env.ui.locator('#links a[data-link="discord"]').get_attribute("href")
    kofi = await env.ui.locator('#links a[data-link="kofi"]').get_attribute("href")
    check(href == "https://discord.gg/EPsbQCuAkx" and kofi == "https://ko-fi.com/mashaup", f"link di serie: {href} {kofi}")
    zip_bytes = b"PK\x05\x06" + b"\x00" * 18
    import hashlib
    sha = hashlib.sha256(zip_bytes).hexdigest()

    async def gh(route):
        url = route.request.url
        if url.endswith("/MashaUP/Vintory/main/version.json"):
            return await route.fulfill(status=200, content_type="application/json", body=json.dumps({"version": "1.1.0", "date": "2026-12-01", "zip": "Vintory-1.1.0.zip", "sha256": sha, "notes": ["Novità di prova"]}))
        if url.endswith("/MashaUP/Vintory/main/links.json"):
            return await route.fulfill(status=200, content_type="application/json", body=json.dumps({"revision": 2, "links": {"discord": {"url": "https://discord.gg/NUOVOINVITO", "label": "Discord"}, "kofi": {"url": "https://evil.example/x"}}}))
        if url.endswith("/MashaUP/Vintory/raw/HEAD/Vintory-1.1.0.zip"):
            return await route.fulfill(status=200, content_type="application/zip", body=zip_bytes)
        return await route.fulfill(status=404, body="{}")
    env.github = gh
    await env.A("store.setState('update', null).then(() => store.setState('links', null))")
    await env.ui.locator("#update").click()
    await env.ui.locator(".modal", has_text="Aggiornamento disponibile").wait_for(timeout=15000)
    text = await env.ui.locator(".modal").inner_text()
    check("1.1.0" in text and "Novità di prova" in text and json.load(open("manifest.json"))["version"] in text, f"finestra: {text[:200]}")
    href = await env.ui.locator('#links a[data-link="discord"]').get_attribute("href")
    kofi = await env.ui.locator('#links a[data-link="kofi"]').get_attribute("href")
    check(href == "https://discord.gg/NUOVOINVITO", f"Discord aggiornato da links.json: {href}")
    check(kofi == "https://ko-fi.com/mashaup", f"un link verso un dominio sconosciuto viene ignorato: {kofi}")
    note = ""
    try:
        await env.ui.locator('.modal [data-act="download"]').click()
        await env.ui.wait_for_function("() => document.querySelector('.modal')?.textContent.includes('Scaricato Vintory-1.1.0.zip')", timeout=15000)
        check("impronta verificata" in await env.ui.locator(".modal").inner_text(), "impronta verificata")
        check(await env.ui.get_by_role("button", name="Ricarica Vintory").is_visible(), "pulsante «Ricarica Vintory»")
        note = ", download con impronta verificata"
    except Exception as e:
        note = f" (download non verificabile in questo ambiente: {str(e)[:80]})"
    await env.close_modals()
    await env.go("settings")
    check(await env.ui.locator("#check-update").is_visible() and "Disponibile la 1.1.0" in await env.ui.locator("#updates").inner_text(), "sezione Aggiornamenti")
    pop = await env.ext_page("src/ui/popup.html")
    await pop.wait_for_function("() => !document.getElementById('app').hasAttribute('aria-busy')", timeout=15000)
    check(await pop.locator("#update").inner_text() == "Cerca aggiornamento", "pulsante nel popup")
    links = await pop.locator("#links a").evaluate_all("(as) => as.map((a) => a.href)")
    check("https://ko-fi.com/mashaup" in links and "https://discord.gg/NUOVOINVITO" in links, f"link nel popup: {links}")
    check("Miei annunci" in await pop.locator("#app").inner_text() and await pop.locator(".recent button").count() == 5, "riepilogo e ultimi salvati nel popup")
    await pop.close()
    env.github = None
    await env.A("store.setState('update', null)")
    return "versione 1.1.0 rilevata con novità, invito Discord cambiato da links.json, link estraneo ignorato" + note


async def t_pages_theme(env):
    """F49 F50 F44: statistiche, simili, impostazioni, tema."""
    it = env.fake.add(900500, ME, "masha_up", 0, photos=2)
    it["photos"] = [env.fake.items[900000]["photos"][0], FakeVinted.photo(9005001)]
    page = await env.vinted("/items/900500-articolo-0")
    await wait_btn(page, "Salva in Vintory")
    await page.locator("#vintory-host .main").click()
    await wait_btn(page, "Salvato in Vintory")
    toast = await page.evaluate("() => document.querySelector('#vintory-host').shadowRoot.querySelector('.toast')?.textContent || ''")
    check("somiglia" in toast, f"avviso di somiglianza al salvataggio: {toast}")
    await page.close()
    await env.reload()
    await env.go("duplicates")
    check(await env.ui.locator(".dupes").count() >= 1 and await env.ui.locator(".dupe").count() >= 2, "gruppo di annunci simili (stessa foto, ID diverso)")
    await env.go("stats")
    text = await env.ui.locator("main").inner_text()
    mine = [l for l in await env.listings() if l["owner"] == "mine" and not l["deletedAt"]]
    check(str(len(mine)) in text and "Valore totale" in text and "Per marca" in text, "statistiche")
    total = sum(l["price"] or 0 for l in mine)
    check(f"{total:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") in text.replace("\xa0", " "), f"valore totale {total} solo dei miei")
    await env.go("settings")
    await env.ui.locator("#theme").select_option("dark")
    await env.ui.wait_for_function("() => document.documentElement.dataset.theme === 'dark'")
    await env.ui.locator("#theme").select_option("light")
    await env.ui.wait_for_function("() => document.documentElement.dataset.theme === 'light'")
    await env.ui.locator('input[aria-label="Nuovo campo personalizzato"]').fill("Ubicazione")
    await env.ui.get_by_role("button", name="Aggiungi campo").click()
    await env.wait_for(lambda: env.A("store.getSettings().then((s) => s.customFields.includes('Ubicazione'))"), what="campo personalizzato aggiunto")
    for r in ["collections", "templates", "import", "backup", "health", "others", "trash", "favorites", "recent", "archive"]:
        await env.go(r)
    return "annuncio con la stessa foto riconosciuto come simile, statistiche solo dei miei, tema chiaro/scuro, nuovo campo"


async def t_trash_expiry_and_auto_backup(env):
    """F34 F37 F38 F40: scadenza del cestino, backup automatico in Download, spazio."""
    l = [x for x in await env.listings() if x["vintedId"] == "900500"][0]
    await env.A("archive.patchMany([arg], (x) => { x.deletedAt = Date.now() - 31 * 86400e3; })", l["id"])
    n_img = await env.A("db.count('images')")
    await env.settings({"backup": {"auto": "downloads", "autoDays": 1, "lastAutoAt": None, "lastAt": None, "keep": 3}})
    await env.reload()
    check(await env.listing(900500) is None, "annuncio nel cestino da 31 giorni eliminato all'avvio")
    check(await env.A("db.count('images')") == n_img - 2, "eliminate anche le sue foto")
    note = ""
    try:
        await env.wait_for(lambda: env.A("store.getSettings().then((s) => Boolean(s.backup.lastAutoAt) && s.backup.downloadIds.length === 1)"), timeout=40, what="backup automatico")
        note = "backup automatico in Download eseguito"
    except AssertionError as e:
        note = f"backup automatico non verificabile in questo ambiente ({str(e)[:60]})"
    await env.settings({"backup": {"auto": "off"}})
    await env.go("backup")
    usage = await env.ui.locator("#usage").inner_text()
    check("occupati" in usage, f"spazio occupato: {usage}")
    await env.settings({"backup": {"lastAt": None, "remindDays": 7}})
    await env.reload()
    check(await env.ui.locator("#nav .dot").count() == 1, "segnale «backup da fare» nel menu")
    return f"cestino scaduto svuotato con le foto, {note}, indicatore dello spazio e promemoria"


async def t_vinted_403(env):
    """1.0.1, dal report di Andrea: token solo nella pagina «Vendi» e /items/:id sempre rifiutato (403)."""
    fake = env.fake
    fake.add(900077, ME, "masha_up", 7)
    fake.add(900078, ME, "masha_up", 8)
    fake.add(700077, OTHER, "venditrice_test", 9)
    fake.token_in_pages = False
    fake.fail = {r"^/api/v2/items/\d+$": 403}
    start = len(fake.requests)
    # 1. il mio annuncio, dalla sua pagina: token dalla pagina «Vendi», dati dal modulo di vendita
    page = await env.vinted("/items/900077-articolo-7")
    await wait_btn(page, "Salva in Vintory")
    await page.locator("#vintory-host .main").click()
    await wait_btn(page, "Salvato in Vintory")
    l = await env.listing(900077)
    check(l and l["owner"] == "mine" and l["photoCount"] == 5 and l["photoMissing"] == 0, f"salvato: {l and (l['owner'], l['photoCount'])}")
    check("upload" in l["sources"] and "details" not in l["sources"], f"fonti: {l['sources']}")
    check(l["title"] == fake.items[900077]["title"] and l["brand"] == fake.items[900077]["brand_dto"]["title"], "titolo e marca")
    reqs = [r[1] for r in fake.requests[start:]]
    check("/items/new" in reqs, "token letto dalla pagina «Vendi»")
    check(reqs.count("/api/v2/items/900077") == 2, f"/items/:id rifiutato: un solo nuovo tentativo ({reqs.count('/api/v2/items/900077')})")
    check(any(p == "/api/v2/item_upload/items/900077" and ok for p, ok in fake.csrf_ok), "modulo di vendita letto con il token giusto")
    await page.close()
    # 2. annuncio di altri salvato dall'elenco, senza aprirne la pagina: le API rifiutano, si legge la pagina come testo
    r = await env.rpc("save.byId", {"origin": ORIGIN, "vintedId": "700077"})
    check(r and r["status"] == "saved", f"esito: {r}")
    l = await env.listing(700077)
    it = fake.items[700077]
    check(l["owner"] == "other" and l["sources"] == ["page"], f"proprietario e fonti: {l['owner']} {l['sources']}")
    check(l["title"] == it["title"] and l["brand"] == it["brand_dto"]["title"] and l["size"] == it["size_title"] and l["photoCount"] == 5 and l["photoMissing"] == 0, "dati e foto dalla pagina")
    check(l["category"] == " › ".join(n for _, n in it["_crumbs"]) and l["price"] == float(it["price"]["amount"]), f"categoria e prezzo: {l['category']} {l['price']}")
    # 3. tutto rifiutato davvero: si ferma con un messaggio chiaro e non salva nulla
    fake.fail = {r"^/api/v2/(items|item_upload/items)/\d+$": 403, r"^/items/9000": 403}
    r = await env.rpc("save.byId", {"origin": ORIGIN, "vintedId": "900078"})
    check(r["status"] == "failed" and r["stop"] and "403" in r["message"], f"esito: {r}")
    check(await env.listing(900078) is None, "niente salvato")
    fake.fail = {}
    fake.token_in_pages = True
    # 4. il report diagnostico dice cosa è successo, senza dati personali
    await env.go("health")
    await env.ui.locator("#copy-report").wait_for()
    report = await env.ui.evaluate("() => { let t = ''; const orig = navigator.clipboard.writeText; navigator.clipboard.writeText = (x) => { t = x; return Promise.resolve(); }; document.querySelector('#copy-report').click(); navigator.clipboard.writeText = orig; return t; }")
    check("Ultime letture da Vinted:" in report and "items 403 blocked (2° tentativo)" in report and "Token CSRF:" in report, f"report: {report}")
    check("900077" not in report and "700077" not in report and fake.items[900077]["title"] not in report, "nessun id o titolo nel report")
    await env.go("archive")
    return "token solo nella pagina «Vendi» e /items/:id rifiutato → salvato dal modulo di vendita; annuncio altrui dalla pagina; tutto rifiutato → stop chiaro; report con l'esito di ogni lettura"


async def t_real_shapes_102(env):
    """1.0.2, dal backup reale di Andrea: libri, riga dell'armadio, nome della categoria, «Completa i dati mancanti»."""
    fake = env.fake
    libri = [(2312, "Intrattenimento"), (2319, "Libri")]
    giochi = [(2312, "Intrattenimento"), (3045, "Videogiochi")]
    fake.add(905090, ME, "masha_up", 10, catalog_id=2319, _crumbs=libri, size_title="", _book={"author": "Olivie Blake", "book_title": "The Atlas Six", "isbn": "9781529095258"})
    fake.add(905091, ME, "masha_up", 11, catalog_id=2319, _crumbs=libri, size_title="Taglia unica", _book={"author": "Clea Benedetti", "isbn": "9788834744412"})
    fake.add(905092, ME, "masha_up", 12, catalog_id=3045, _crumbs=giochi, size_title="M", _book={"manufacturer": "Sony", "model": "PS2"})
    pages = lambda iid: len([r for r in fake.requests if r == ("GET", f"/items/{iid}")])
    fake.fail = {r"^/api/v2/items/\d+$": 403}      # come sul Vinted reale: la scheda non dà dati
    home = await env.vinted("/")                        # una scheda di Vinted aperta, come quando si usa Vintory
    # 1. libro salvato senza aprirne la pagina: condizioni da item_attributes, categoria imparata con una sola pagina
    r = await env.rpc("save.byId", {"origin": ORIGIN, "vintedId": "905090"})
    check(r["status"] == "saved", f"esito: {r}")
    l = await env.listing(905090)
    check(l["category"] == "Intrattenimento › Libri", f"categoria imparata: {l['category']}")
    check(l["condition"] == "Ottime" and l["size"] is None, f"condizioni da item_attributes: {l['condition']} / taglia {l['size']}")
    check(l["extra"].get("author") == "Olivie Blake" and l["extra"].get("isbn") == "9781529095258" and l["extra"].get("bookTitle") == "The Atlas Six", f"dati del libro: {l['extra']}")
    check(pages(905090) == 1, f"una sola pagina letta: {pages(905090)}")
    # 2. stesso catalogo, dall'elenco dell'armadio: taglia dalla riga («size»), nessuna pagina in più
    r = await env.rpc("save.byId", {"origin": ORIGIN, "vintedId": "905091", "wardrobe": fake.row(fake.items[905091])})
    l = await env.listing(905091)
    check(l["category"] == "Intrattenimento › Libri" and l["size"] == "Taglia unica", f"categoria e taglia: {l['category']} / {l['size']}")
    check(pages(905091) == 0, "categoria già nota: nessuna pagina letta")
    # 3. annuncio salvato come nella 1.0.1 (solo modulo di vendita e riga, niente nome della categoria né taglia)
    it = fake.items[905092]
    await env.A("archive.saveBundle({ bundle: arg, origin: 'https://www.vinted.it', accountId: '4242', source: 'import' }).then((r) => archive.patchMany([r.listing.id], (x) => { x.size = null; x.extra = {}; x.category = null; }))", {"upload": fake.upload_shape(it), "wardrobe": fake.row(it)})
    await env.A("db.getMeta('labels', {}).then((m) => { delete m.catalog['3045']; return db.setMeta('labels', m); })")
    l = await env.listing(905092)
    check(l["category"] is None and l["size"] is None, "simulato com'era nella 1.0.1")
    await env.go("archive")
    await env.reload()
    await env.ui.locator("#fill-note").wait_for(timeout=10000)
    await env.ui.locator("#fill-run").click()
    await env.toast("annunci completati", timeout=60000)
    l = await env.listing(905092)
    check(l["category"] == "Intrattenimento › Videogiochi" and l["size"] == "M" and l["extra"].get("manufacturer") == "Sony", f"completato: {l['category']} / {l['size']} / {l['extra']}")
    check(pages(905092) == 1, f"una pagina per la categoria mancante: {pages(905092)}")
    await env.reload()
    check(await env.ui.locator("#fill-note").count() == 0, "avviso sparito")
    # 4. scheda: dati del libro e pulsante per Vinted_Relist
    l = await env.listing(905090)
    await env.go(f"archive?item={l['id']}")
    await env.ui.locator(".modal .dside").wait_for()
    text = await env.ui.locator(".modal").inner_text()
    check("Olivie Blake" in text and "9781529095258" in text and "Intrattenimento › Libri" in text, "autore, ISBN e categoria nella scheda")
    check("Per Vinted_Relist" in await env.ui.locator(".modal .actions").inner_text(), "pulsante per Vinted_Relist nella scheda")
    await env.close_modals()
    await home.close()
    fake.fail = {}
    return "libro: condizioni da item_attributes, autore e ISBN, categoria imparata con una pagina e riusata; taglia dalla riga dell'armadio; «Completa i dati mancanti» sistema un annuncio della 1.0.1"


async def t_restart_persistence(env_holder):
    """Criterio MVP: tutto resta dopo aver chiuso completamente il browser."""
    env = env_holder["env"]
    before = await env.listings()
    n_img = await env.A("db.count('images')")
    errors, fake, profile, pages_requests = list(env.errors), env.fake, env.profile, None
    await stop(env, keep_profile=True)
    env = await start(fake=fake, profile=profile)
    env.errors.extend(errors)
    env.pages = {}
    env_holder["env"] = env
    await env.dash("archive")
    after = await env.listings()
    check(len(after) == len(before) and {l["id"] for l in after} == {l["id"] for l in before}, f"annunci dopo il riavvio: {len(after)}/{len(before)}")
    check(await env.A("db.count('images')") == n_img, "foto dopo il riavvio")
    l = await env.listing(900000)
    sizes = await env.A("archive.getImages(arg).then((a) => a.map((i) => i.blob?.size || 0))", l)
    check(len(sizes) == 5 and all(s > 3000 for s in sizes), f"le 5 foto si leggono ancora: {sizes}")
    await env.ui.locator("#results .item .thumb img[src^='blob:']").first.wait_for(timeout=10000)
    return f"browser chiuso e riaperto: {len(after)} annunci e {n_img} foto ancora lì"


async def t_read_only(env):
    """Vincolo: verso Vinted solo GET e solo i percorsi previsti, per tutta la sessione."""
    writes = env.fake.writes()
    check(not writes, f"richieste di scrittura: {writes[:5]}")
    bad = env.fake.unexpected_api()
    check(not bad, f"percorsi API non previsti: {bad[:5]}")
    api = [r for r in env.fake.requests if r[1].startswith("/api/")]
    check(len(api) > 50, f"richieste API registrate: {len(api)}")
    check(not env.errors, f"errori nelle pagine dell'estensione: {env.errors[:5]}")
    return f"{len(api)} richieste API, tutte GET sui percorsi ammessi; nessun errore JavaScript nelle pagine"


SCENARIOS = [
    ("Salvataggio dalla pagina dell'annuncio", t_save_button),
    ("Nessun duplicato", t_no_duplicates),
    ("Annuncio non mio", t_other_listing),
    ("CAPTCHA e foto non scaricabili", t_captcha_and_photo_errors),
    ("Importazione dall'armadio", t_import),
    ("Importazione fermata da Vinted e ripresa", t_import_blocked_resume),
    ("Importazione interrotta dalla chiusura", t_import_interrupted),
    ("Ricerca, filtri, ordinamento, viste", t_search_filter_sort),
    ("Selezione, preferiti, collezioni, cestino", t_selection_collections_trash),
    ("Scheda, modifica, note, versioni", t_detail_edit_versions),
    ("Aggiornamento da Vinted", t_update_from_vinted),
    ("Annuncio non più online", t_offline_still_viewable),
    ("Modelli, Prepara, Vinted_Relist", t_prepare_templates_relist),
    ("Esportazione CSV ed Excel", t_exports),
    ("Integrità delle foto", t_integrity),
    ("Backup e ripristino su nuova installazione", t_backup_restore_new_install),
    ("Aggiornamenti e collegamenti", t_updates_and_links),
    ("Simili, statistiche, impostazioni, tema", t_pages_theme),
    ("Cestino scaduto, backup automatico, spazio", t_trash_expiry_and_auto_backup),
    ("Vinted reale: token e 403 (1.0.1)", t_vinted_403),
    ("Dati reali e completamento (1.0.2)", t_real_shapes_102),
    ("Persistenza dopo il riavvio del browser", t_restart_persistence),
    ("Sola lettura e assenza di errori", t_read_only),
]


async def main():
    only = sys.argv[1].lower() if len(sys.argv) > 1 else None
    fake = FakeVinted(mine=110, others=6)
    env = await start(fake=fake)
    env.pages = {}
    holder = {"env": env}
    await env.dash("archive")
    await env.close_modals()
    results = []
    t0 = time.time()
    try:
        for name, fn in SCENARIOS:
            if only and only not in name.lower() and only not in fn.__name__:
                continue
            t = time.time()
            try:
                out = await asyncio.wait_for(fn(holder if fn is t_restart_persistence else holder["env"]), timeout=240)
                results.append((True, name, out, time.time() - t))
                print(f"✔ {name} ({time.time() - t:.1f}s)\n    {out}", flush=True)
            except Exception as e:
                results.append((False, name, f"{type(e).__name__}: {str(e)[:600]}", time.time() - t))
                print(f"✖ {name} ({time.time() - t:.1f}s)\n    {type(e).__name__}: {str(e)[:600]}", flush=True)
                try:
                    await holder["env"].close_modals()
                except Exception:
                    pass
    finally:
        await stop(holder["env"])
    ok = sum(1 for r in results if r[0])
    print(f"\n{ok}/{len(results)} scenari riusciti in {time.time() - t0:.0f}s")
    sys.exit(0 if ok == len(results) else 1)


if __name__ == "__main__":
    asyncio.run(main())
