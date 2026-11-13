"""Crea le schermate di docs/screenshots (archivio, scheda, popup) dal Vinted finto: le foto sono riquadri colorati di prova. Uso: python3 tests/e2e/screenshots.py"""
import asyncio, os
from harness import start, stop
from fake_vinted import FakeVinted, ORIGIN, ME

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "docs", "screenshots"))


async def main():
    env = await start(fake=FakeVinted(mine=40, others=4))
    try:
        await env.dash("archive")
        await env.close_modals()
        await env.ui.set_viewport_size({"width": 1360, "height": 860})
        await env.settings({"importDelay": {"min": 0, "max": 0}, "theme": "light"})
        await env.reload()
        page = await env.vinted(f"/member/{ME}")
        await page.wait_for_function("() => document.querySelector('#vintory-host')?.shadowRoot?.querySelector('.main')")
        await page.locator("#vintory-host .main").click()
        await env.ui.bring_to_front()
        await env.ui.wait_for_function("() => document.querySelector('#preview')?.textContent.includes('annunci letti')", timeout=30000)
        await env.ui.get_by_role("button", name="Nessuno").click()
        for i in range(14):
            await env.ui.locator("#preview .item.pv .pick input").nth(i).check()
        await env.ui.locator("#import-start").click()
        await env.ui.locator('details.job[data-status="done"]').wait_for(timeout=120000)
        await env.go("archive")
        await env.ui.locator("#results .item .thumb img[src^='blob:']").nth(7).wait_for(timeout=10000)
        await asyncio.sleep(0.5)
        await env.ui.screenshot(path=f"{OUT}/archivio.png")
        await env.ui.locator("#results .item .thumb").first.click()
        await env.ui.locator(".modal .dside").wait_for()
        await env.ui.wait_for_function("() => document.querySelector('.modal .gallery .main')?.naturalWidth > 0")
        await asyncio.sleep(0.3)
        await env.ui.screenshot(path=f"{OUT}/scheda.png")
        await env.close_modals()
        pop = await env.ext_page("src/ui/popup.html")
        await pop.set_viewport_size({"width": 380, "height": 520})
        await pop.wait_for_function("() => !document.getElementById('app').hasAttribute('aria-busy')")
        await asyncio.sleep(0.5)
        await pop.screenshot(path=f"{OUT}/popup.png")
        print("schermate:", sorted(os.listdir(OUT)), "errori:", env.errors)
    finally:
        await stop(env)

asyncio.run(main())
