# CTSS Correspondence 938

The browser fonts are [CTSS-Correspondence-938.woff2](CTSS-Correspondence-938.woff2) and [CTSS-Correspondence-Extended.woff2](CTSS-Correspondence-Extended.woff2). Matching TTF files and a [specimen](specimen.png) are included. Load [font.css](font.css) for text, or use [strike.js](strike.js) for paper impressions and optional printing animation. The previous one-impression trace remains as [CTSS-Correspondence-938-Impression.woff2](CTSS-Correspondence-938-Impression.woff2), with its own [specimen](specimen-impression.png). [demo.html](demo.html) lets you compare both faces.

## Sources and limits

- The character repertoire comes from page 19 of the [MIT typeface archive scan](../references/IBM-938-standard-correspondence-typefaces.pdf), explicitly marked `Standard Correspondence`, `#938`, and `Printed on 1050`. A separate `ball 938` CTSS print test appears on page 31. Both pages are rendered as 300 DPI grayscale images, then thresholded consistently for the build. The archive does not establish that the two sheets used the same physical element or ribbon.
- The [IBM 1050 manual](../references/IBM-1050-system-operation-manual-1965.pdf) describes 88 printable positions, 44 per shift (PDF page 12), and charts the terminal character codes in figure 44 (PDF page 85).
- [CTSS Programming Staff Note 69](https://web.mit.edu/Saltzer/www/publications/ctss/psn-69.pdf) identifies the 938 standard correspondence ball as the then-default 1050 element.

The core font follows the 938 element's 88 printed positions: 86 distinct characters because comma and period each occur twice. No core sign is invented. Space is a carrier advance, not an impression. The build removes the slight slope of the scanned proof, registers impressions to a common baseline, rejects poor matches, and keeps each repaired consensus on the clearer proof impression's vertical registration. It removes isolated specks from symbols but does not morphologically close their narrow white gaps: the original scan already separates the bars of `=`, the dot of `!`, and the stems of `#`. For symbols with only two usable strikes it retains the clearer page-31 outline rather than letting the over-inked page-19 strike fill counters or merge separate marks. The sole `±` strike joins plus and minus at a narrow ink neck; separating them is an explicitly uncertain inference from the identified sign. Letters, digits, and symbols with more strikes use a consensus so isolated ink dropouts are not made permanent. Of 86 glyphs, 81 have at least two accepted impressions. `◇`, `_`, `¢`, `@`, and `±` have only one usable impression and remain uncertain. [manifest.json](manifest.json) records accepted sample locations for every glyph. None of the marks is claimed as verified damage to a particular element.

The source establishes the layout and printed forms, but it cannot uniquely recover pristine metal outlines or distinguish every element defect from ribbon, paper, and scanning. The companion font includes CTSS graphics absent from the 938 element and modern characters; it is not a claim about the historical 938 repertoire.

The font advance is 600 units on a 1000-unit em. At 16 CSS pixels this is 9.6 pixels per character, equivalent to 10 characters per inch at 96 pixels per inch. The strike renderer sets line advance and timing separately. Its default rate is 14.8 characters per second; carrier-return delay is configurable. Added ribbon wear and strike-position variation are separate, optional per-impression controls; both default to zero. The app likewise applies neither effect unless configured. `mapBackslashToCent: true` explicitly maps input `\` to the historical cent sign. The default leaves backslash as a modern companion glyph.

## Rebuild and preview

Install [Poppler](https://poppler.freedesktop.org/) for `pdftoppm`, then run:

```sh
cd font
uv sync --locked
uv run --locked python build.py
```

Dependencies are exact-pinned in [pyproject.toml](pyproject.toml) and [uv.lock](uv.lock). To preview in a browser, serve the repository root with `python3 -m http.server 8765` and open `/font/demo.html`.
