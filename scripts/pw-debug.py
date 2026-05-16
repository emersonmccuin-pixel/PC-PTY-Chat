"""Headless debug: load the React app, dump console + page errors, screenshot."""
from playwright.sync_api import sync_playwright
import sys

# Force UTF-8 on Windows stdout so arrows/box-drawing in the page don't crash print.
sys.stdout.reconfigure(encoding="utf-8")

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173/"
SHOT = sys.argv[2] if len(sys.argv) > 2 else "scripts/pw-debug.png"

console_msgs = []
page_errors = []
failed_requests = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    page = context.new_page()

    page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.on("requestfailed",
            lambda r: failed_requests.append(f"{r.method} {r.url} -> {r.failure}"))

    print(f"Loading: {URL}")
    page.goto(URL, wait_until="networkidle", timeout=15000)
    page.wait_for_timeout(1500)

    body_text = page.evaluate("() => document.body.innerText")
    root_html = page.evaluate("() => document.getElementById('root')?.innerHTML ?? '<no #root>'")
    root_len = len(root_html)

    page.screenshot(path=SHOT, full_page=True)
    browser.close()

print()
print(f"=== body.innerText (len={len(body_text)}) ===")
print(body_text[:1000] if body_text else "(empty)")
print()
print(f"=== #root innerHTML (len={root_len}) ===")
print(root_html[:800] if root_len else "(empty)")
print()
print(f"=== Console ({len(console_msgs)}) ===")
for m in console_msgs:
    print(m)
print()
print(f"=== Page errors ({len(page_errors)}) ===")
for e in page_errors:
    print(e)
print()
print(f"=== Failed requests ({len(failed_requests)}) ===")
for r in failed_requests:
    print(r)
print()
print(f"Screenshot: {SHOT}")
