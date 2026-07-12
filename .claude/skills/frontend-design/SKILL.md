---
name: frontend-design
description: Rules for any visual/UI/CSS change in the Printable storefront — editing styles.css or admin.css, adjusting spacing, colors, typography, layout, responsive behavior, hover states, or adding a new section/component to index.html, stl-teklif.html, admin.html, or login.html. Read this BEFORE writing any CSS, because styles.css is a stack of override layers where the naive edit silently does nothing.
---

# Frontend design — Printable storefront

Plain HTML + CSS + vanilla JS. No build step, no framework, no preprocessor. What you write in `styles.css` is what the browser loads.

## The one thing that will bite you: styles.css is layered

`styles.css` (~2100 lines) is not organized by component. It is a **chronological stack of redesign passes**, each appended to the bottom, each re-declaring selectors defined above it:

| Line | Layer |
|---|---|
| 1–612 | Original base (tokens, layout, components) |
| 613–678 | Base responsive (`1050px`, `720px`, `460px`) |
| 679+ | `/* Printable refined storefront */` |
| 1379+ | `/* Wider, more premium upper layout */` |
| 1543+ | `/* Premium header and navigation */` |
| 1674+ | `/* Signature button system */` |
| 1796+ | `/* Single-line refined header */` |
| 1894+ | `/* Refined hero banner copy and actions */` |
| 1997+ | `/* Polished header controls */` |

`.btn`, `.product-card`, `.header-main` and `.hero__copy` each exist in **three or four** of these layers. Media queries are interleaved between layers, so a `@media` block at line 625 is overridden by a plain rule at line 900.

**Therefore, before editing any selector:**

```bash
grep -n "\.selector-name" styles.css
```

Edit the **last-winning** declaration, not the first one you find. If you change line 200 and the value is redeclared at line 1300, your change does nothing and you will think the CSS "isn't loading".

Prefer editing an existing rule over appending a new layer. Appending is how this file got to 2100 lines.

## Selector discipline — scope to direct children

The markup nests `<span>` inside buttons:

```html
<a class="btn btn--ghost" href="#store-products"><span>Ürünleri incele</span></a>
```

So a descendant selector like `.hero__copy span { margin-bottom: 24px; font-size: 18px; }` also hits **every button label inside the hero**, inflating button height and font size. This was a real bug. Those rules are now `.hero__copy > span`.

- Use `>` when you mean "the block's own text/element", not "any descendant".
- Never style a bare tag (`span`, `p`, `a`, `img`, `button`) under a block selector without checking what components live inside that block.
- Style components by their own class (`.btn`, `.product-card`), never by their position inside a parent.

## Design tokens

Defined in `:root` at the top of `styles.css`. Use them; do not hardcode a hex that duplicates one:

```css
--blue: #1b1d27;   --accent: #ff6542;  /* primary orange — CTAs, underlines */
--pink: #ff4aa1;   --cyan:   #00d7f5;
--text: #171722;   --muted:  #6c7180;
--line: #e8eaf0;   --soft:   #f6f7fb;
```

New colors: add a token rather than inlining, unless it is a one-off `rgba()` overlay.

## Fonts

Manrope is **self-hosted**, not loaded from Google Fonts: the variable woff2 files live in `assets/fonts/` (`latin` + `latin-ext` — Turkish needs `latin-ext` for `ğ ş İ`), are declared via `@font-face` at the top of both `styles.css` and `admin.css`, and are `<link rel="preload" as="font" crossorigin>`ed in all four HTML heads. This is what stops the flash-of-fallback-font on load. Don't reintroduce a `fonts.googleapis.com` `<link>`, and if you add a page, copy the two preload tags into its `<head>`.

## Fluid sizing

Fluid type/space uses `clamp()` — e.g. `font-size: clamp(30px, 3.2vw, 46px)`, `padding: clamp(30px, 6vw, 72px)`. Follow that pattern for anything that must survive from 460px to 1440px instead of adding another media query.

## Naming

BEM-ish, already consistent — keep it:

- Block: `.hero`, `.product-card`, `.promise-bar`
- Element: `.hero__grid`, `.hero__copy`, `.hero__slider`, `.promise-bar__grid` (double underscore)
- Modifier: `.btn--light`, `.btn--ghost`, `.btn--aqua`, `.products--four` (double dash)
- State: `.open`, `.active`, `.is-visible` (toggled from JS, never styled as a base)

## Breakpoints

Only three. Do not invent a fourth:

```css
@media (max-width: 1050px) { /* tablet: hero side rail off, 3-col grids */ }
@media (max-width: 720px)  { /* mobile: hero copy goes static + dark bg, 2-col grids */ }
@media (max-width: 460px)  { /* small phone */ }
```

At `720px` the hero stops being an image overlay: `.hero__copy` becomes `position: static` with a solid `#1f2128` background and the gradient pseudo-elements are disabled. Any hero change must be checked in both modes — a rule that only makes sense over the photo will look broken in the stacked layout.

## Components that already exist — reuse before inventing

- `.btn` + `.btn--light` (transparent/outlined, on dark) / `.btn--ghost` (white, on photo) / `.btn--aqua`
- `.product-card` — image, `h3`, price `p`, `.swatches`, add-to-cart `button`. Rendered from JS (`renderProducts()` in `script.js`), so its markup lives in a template literal, not in `index.html`.
- `.container` — page width wrapper (`min(100% - 22px, 1180px)`)
- `.badge` (+ `.green` / `.orange` / `.blue`) — admin only
- Page sections in `index.html`: `.hero`, `.promise-bar`, `.stl-quote`, `.product-section`, `.cyber`, `.categories`, `.split-products`, `.service-row`, `.twin-banners`, `.oled-banner`, `.sale-banner`, `.why`, `.cart-panel`, `.footer`

## Content language

All user-facing copy is **Turkish**. Keep class names, IDs, and code comments in English; keep every visible string, `alt`, `aria-label`, placeholder, and error message in Turkish. Prices render as `24.90 TL` via the shared `money()` helper.

## Accessibility floor

Don't regress what's there: the search toggle maintains `aria-expanded`, the cart panel has `aria-label`, Escape closes the search popover. Any new interactive element needs a real focusable control (`button`/`a`), an accessible name, and a visible focus state. Images need `alt` (empty `alt=""` only when decorative).

## Verifying

CSS bugs in this file are usually specificity/override bugs, and you cannot see those by reading the diff. Actually load the page — use the `run-preview` skill.
