# Chakils teklif belgesi şablon sözleşmesi

## Reference

- Source: `C:\Users\ogulcan\Documents\GitHub\printable\output\Mega_Insulation_Figur_Fiyat_Teklifi.docx`
- SHA-256: `5C330DB16BF5D1FF72FBD9B804475F983E5FF8CCD0374F76026C86B88788607D`
- Page count: 1
- Section count: 1
- Reference render: `C:\Users\ogulcan\Documents\GitHub\printable\tmp\quote-reference\page-1.png`
- Style evidence: `C:\Users\ogulcan\Documents\GitHub\printable\tmp\chakils-quote\template-style-evidence.json`

## Page system

- Letter portrait, 8.50 x 11.00 inches.
- Margins: left 0.79, right 0.79, top 0.71, bottom 0.71 inches.
- Header and footer distance: 0.50 inches.
- One section, no first-page or odd-even variants.

## Visual system

- Primary typeface: Calibri.
- Main colors: navy `14213D`, orange `FF6542`, near-black `11141A`, gray `6B7280`, pale gray `F1F3F6`, white `FFFFFF`.
- Top identity block: two-column navy table, logo and descriptor at left; document label, date, and buyer at right.
- Main title: 22 pt bold, black; subtitle: 11 pt; body: 11 pt; section headings: 14 pt bold.
- Price table: navy header with white text, alternating pale rows, deliberate column widths, and right-aligned money values.
- Commercial conditions: orange bullet, bold label, regular explanatory text.
- Footer: centered secondary text.

## Content flow and slot map

1. `word/document.xml` first table: preserve logo image, navy fill, proportions, and left descriptor. Rewrite only the date and buyer text in the right cell.
2. Body paragraph 1: rewrite as the offer title and apply Word Title style while preserving source-derived appearance.
3. Body paragraph 2: rewrite as quantity and production subtitle.
4. Body paragraph 3: rewrite as a concise recipient-specific opening.
5. Body paragraph 5: rewrite section title as `Fiyatlandırma`.
6. `word/document.xml` second table: preserve the pricing-table component and expand it to four columns. Reuse five source rows as header, product, subtotal, KDV, and grand total rows.
7. Body paragraph 7: retain `Ticari Koşullar`.
8. Body paragraphs 8 to 12: use as KDV, payment, lead time, validity, and production-approval conditions.
9. Body paragraph 13: retain the centered Printable footer and add verified contact details on a second line.

## Package preservation

- Preserve-only: `word/media/image1.png`, theme, font table, numbering, relationships, custom XML, content types, and package relationship files.
- Editable: `word/document.xml`, `word/styles.xml`, and document metadata required for the new title.
- The logo image remains the original 1.77 x 0.63 inch inline asset.
- No fields, content controls, footnotes, comments, headers, or footers exist in the source.

## Fidelity gates

- Final output remains one Letter portrait page.
- Top navy identity block and logo remain visually unchanged apart from buyer/date copy.
- Table and bullets must not clip, overlap, or force a second page.
- All price arithmetic must read: 1,000 x 106.25 TL = 106,250.00 TL; 20 percent KDV = 21,250.00 TL; gross total = 127,500.00 TL.
- Source document hash must remain unchanged.
