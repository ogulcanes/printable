---
name: seo
description: SEO work on Printable — page titles, meta descriptions, Open Graph / social previews, canonical URLs, robots, JSON-LD structured data, image alt text, headings, or a new public page. Read before adding a page, changing <head>, or touching anything a crawler reads, because meta tags here are injected server-side and a client-side change silently does nothing for social previews.
---

# SEO — Printable

Admin-editable from `/admin` → **SEO** tab. Two forms: per-page meta (`seo_pages`) and site-wide identity used for JSON-LD (`site_settings`). Image alt text lives on each record: the **Banner** tab has "Görsel alt metni", the product form has "Fotoğraf alt metni".

## The rule that governs everything: meta is server-rendered

`index.html` and `stl-teklif.html` contain a single `<!--seo-->` placeholder in `<head>`. `sendPage()` in `server.js` reads the file, replaces that placeholder with the output of `seoHead(req, slug)`, and sends the result. **Nothing else may set meta.**

- **Never set `<title>`, `<meta name="description">`, OG, canonical, or JSON-LD from JavaScript.** Googlebot renders JS, but the social-preview crawlers (WhatsApp, X, LinkedIn, Slack, Facebook) do **not** — a JS-injected `og:image` yields a blank share card. This is the single most common way to silently break SEO in this codebase.
- **Do not add a static `<title>` to a server-rendered page.** `seoHead()` emits one; a hardcoded one produces two titles and the crawler picks the wrong one. Both public pages had theirs removed for exactly this reason.
- Anything a crawler must see (product data, banner copy) has to be in the HTML the server sends, or in JSON-LD — not only in a `fetch()` result. The product grid and the banner slides are currently rendered client-side from `/api/products` and `/api/hero-slides`, so **their content is invisible to non-JS crawlers.** If SEO for products starts to matter, that is the thing to fix, not more meta tags.

## Adding a public page — the checklist

1. Put `<!--seo-->` in `<head>`, and no `<title>`.
2. Add the route: `app.get("/path", (req, res) => sendPage(req, res, "file.html", "slug"));`
3. Insert a `seo_pages` row for the slug (add it to the seed block, **and** ship an idempotent insert for existing databases — see the `sqlite-schema` skill; a `CREATE TABLE`-only change never reaches a database that already exists).
4. Give it a `label`, so it shows up in the admin SEO tab's page dropdown.
5. Copy the two font `<link rel="preload">` tags into the head (see `frontend-design`).

Admin pages (`/admin`, `/login`) are session-gated and deliberately have no SEO wiring. Do not add any.

## Values and escaping

- All values are HTML-escaped through `escapeHtml()` before they reach the markup, and `<` is escaped to `<` inside the JSON-LD `<script>` so an admin-entered value can never break out of it. **Keep it that way** — these fields are admin-controlled, which is not the same as trusted.
- `canonical`, `og:image` and JSON-LD `url` are passed through `absoluteUrl()`. Relative URLs are ignored by crawlers, so this is not cosmetic. The base comes from `site_settings.site_url`, falling back to the request host. **Set `site_url` to the real production domain before launch** — otherwise a production canonical can end up pointing at whatever `Host` header the request carried.
- `twitter:card` flips to `summary_large_image` automatically when an OG image is set. Don't hardcode it.
- Fallback chain, already implemented: `og_title → title`, `og_description → description`, page `title → site_name`. Leave the optional fields blank in the admin rather than duplicating text.
- Image `alt`: `image_alt → title/name → generic string`. Alt text is a real ranking and accessibility signal — describe the image, don't stuff keywords.

## Turkish content

`<html lang="tr">`, `og:locale` is `tr_TR`, `inLanguage` is `tr-TR`. All meta copy is Turkish. Keep titles ≤ ~60 characters and descriptions ≤ ~155, or search engines truncate them (the admin inputs have `maxlength` at 70/170 as a soft guard).

## Known gaps — say so rather than pretending they're covered

- **No product detail pages.** `products.meta_title` / `meta_description` are stored and editable but **currently rendered nowhere** — they exist for when product pages land. `image_alt` *is* used today. Don't claim product SEO works end to end.
- **No `robots.txt` and no `sitemap.xml`.** Neither exists yet; both are worth adding when the site goes live on a real domain.
- **Client-rendered catalog** — see above.
- On Vercel the SQLite file is ephemeral, so SEO edits made in production do not survive a cold start. Real deployment needs an external database (see `api-endpoint`).
