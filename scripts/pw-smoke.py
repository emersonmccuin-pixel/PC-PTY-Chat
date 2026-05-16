"""End-to-end smoke: create a work item via the form, move it to Review, verify."""
from playwright.sync_api import sync_playwright
import sys
import time

# Force UTF-8 on Windows stdout.
sys.stdout.reconfigure(encoding="utf-8")

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173/"
TITLE = f"pw-smoke-{int(time.time())}"

errors = []
console = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console",
            lambda m: console.append(f"[{m.type}] {m.text}")
            if m.type in ("error", "warning") else None)

    page.goto(URL, wait_until="networkidle", timeout=15000)
    page.wait_for_selector("text=Project Companion")

    # 1. Create
    print(f"Creating work item: {TITLE}")
    page.locator("input[placeholder*='work item title']").fill(TITLE)
    page.locator("button:has-text('Create')").click()
    page.wait_for_selector(f"text={TITLE}", timeout=5000)
    print("  -> visible in DOM")

    # 2. Find the card's stage-move dropdown and move to Review.
    card = page.locator(f"div[data-slot=card]:has-text('{TITLE}')")
    select = card.locator("select")
    select.select_option(value="review")
    print("  -> selected stage 'review'")
    page.wait_for_timeout(1000)

    # 3. Reload + verify the card is in the Review column.
    page.reload(wait_until="networkidle")
    page.wait_for_selector(f"text={TITLE}", timeout=5000)
    moved_card = page.locator(f"div[data-slot=card]:has-text('{TITLE}')")
    current_stage_label = moved_card.locator("select option:checked").text_content()
    print(f"  -> after reload, card's selected stage: {current_stage_label!r}")

    page.screenshot(path="scripts/pw-smoke-after.png", full_page=True)
    browser.close()

print()
print(f"Page errors: {len(errors)}")
for e in errors:
    print("  " + e)
print(f"Console warnings/errors: {len(console)}")
for c in console:
    print("  " + c)

if errors:
    sys.exit(1)
if "Review" not in (current_stage_label or ""):
    print("FAIL: card is not in Review after reload")
    sys.exit(1)
print("PASS")
