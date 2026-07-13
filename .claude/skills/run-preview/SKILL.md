---
name: run-preview
description: Start the Printable app locally and actually look at a change in the browser — use when asked to run/start/preview the site, take a screenshot, or confirm that a UI, storefront, or admin change works. Also the project's launch procedure for the built-in /run and /verify skills.
---

# Run & preview Printable

## Start

```bash
npm start        # node server.js — http://localhost:3000
```

Run it with `run_in_background: true`; it does not exit. It rebinds nothing on reload, so **restart it after editing `server.js`**. Editing `styles.css`, `script.js`, or any `.html` needs no restart — just reload the browser (hard-reload, `Ctrl+F5`, since CSS is served without cache-busting).

If port 3000 is taken: `PORT=3001 npm start` (Bash) or `$env:PORT=3001; npm start` (PowerShell).

## Where to look

| URL | What |
|---|---|
| `/` | Storefront (`index.html`) — hero, product grids, cart panel |
| `/stl-teklif` | STL upload / quote page |
| `/admin` | Admin panel — redirects to `/login` when unauthenticated |
| `/login` | Admin login |
| `/api/products` | Public JSON — quick check that the DB is seeded |

Local admin credentials come from `.env.example` defaults: **admin / printable-admin** (`ADMIN_USER` / `ADMIN_PASSWORD`). The server prints them on boot.

On first boot the server creates `data/printable.sqlite` and seeds three products. If the storefront grid is empty, the DB is the first thing to check: `curl -s localhost:3000/api/products`.

## Verify a change — don't stop at "the server started"

There are no tests in this repo. The only real verification is exercising the flow:

- **Storefront UI** — open `/`, and check the affected breakpoint at all three widths (1440, 1000, 420) if the change touches layout. Hero, header, and product cards each have desktop and mobile variants that diverge (see `frontend-design`).
- **Cart / checkout** — add to cart, submit `#checkout-form`, confirm the alert shows an order number (`PRN-…`), then confirm it appears in `/admin` under Siparişler.
- **Admin** — log in first; every admin API returns `401` without the session cookie and `admin.js` bounces you to `/login`.
- **API** — `curl` the endpoint. Admin endpoints need the cookie:
  ```bash
  curl -s -c /tmp/c.txt -X POST localhost:3000/api/login \
    -H 'Content-Type: application/json' -d '{"username":"admin","password":"printable-admin"}'
  curl -s -b /tmp/c.txt localhost:3000/api/stats
  ```

Report what you actually observed. If you could not load the page, say so — do not infer success from a clean diff.

## Driving a real browser (screenshots, layout measurements, JS errors)

`playwright-core` is installed in `node_modules` but deliberately **not** in `package.json` — it drives the machine's existing Chrome, so no browser download is needed:

```js
const { chromium } = require("./node_modules/playwright-core");
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.log("JS ERROR:", String(e)));  // catches what curl never will
await page.goto("http://localhost:3000/stl-teklif", { waitUntil: "networkidle" });
```

If it is missing: `npm install --no-save playwright-core`.

Use it for anything you cannot see in the HTML source — computed layout (`getBoundingClientRect()`), whether the page scrolls (`scrollHeight` vs `clientHeight`), and above all **runtime JS errors**. The STL viewer was silently dead for a while (a bare `"three"` import specifier with no import map); `curl` returned a perfect 200 for every file and the bug was only visible in the browser console. `page.setInputFiles("#stl-file", "/path/to.stl")` exercises the STL upload end to end.

Note the option is `newPage({ viewport })` — `viewportSize` is silently ignored and you will measure the default 1280×720 without noticing.
