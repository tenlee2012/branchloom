# Third-Party Software Notices

Branchloom is licensed under the Apache License 2.0. It also uses third-party software that remains subject to its own license terms and copyright notices.

## Reciprocal runtime dependency

The desktop application uses:

- `elkjs` 0.11.1 — Eclipse Public License 2.0 (`EPL-2.0`)
  - Source: <https://github.com/kieler/elkjs>
  - License: <https://www.eclipse.org/legal/epl-2.0/>

Branchloom does not relicense `elkjs`. Recipients may obtain its source and license from the upstream project above.

## Kinship calculator

The family tree's local kinship calculator uses `relationship.js` 1.2.9
([source](https://github.com/mumuy/relationship)) under the MIT License:

> Copyright (c) 2016 Haole Zheng
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Genealogy PDF publication

- Noto Serif CJK SC Regular 2.003 — SIL Open Font License 1.1. Copyright 2017–2024 Adobe. The unmodified font and full license are in [packages/core/assets/fonts](packages/core/assets/fonts/README.md). The font is subset-embedded in generated PDFs; its license is also available from the publication page and the installed CLI receipt.
- `pdfjs-dist` 5.4.624 — Apache License 2.0. [PDF.js source](https://github.com/mozilla/pdf.js). PDF.js previews generated documents offline; its distributed CMap, standard-font and decoder license files are retained alongside those assets.
- `krilla` 0.8.2 and its Hayro PDF-import dependencies — MIT OR Apache License 2.0. [Krilla source](https://github.com/LaurenzV/krilla), [Hayro source](https://github.com/LaurenzV/hayro).
- `image` 0.25.10 — MIT OR Apache License 2.0. [Image source](https://github.com/image-rs/image).
- `ttf-parser` 0.25.1 — MIT OR Apache License 2.0. [ttf-parser source](https://github.com/harfbuzz/ttf-parser).

## Release inventory

Before publishing a binary release, generate and review a complete third-party license inventory from the exact npm and Cargo lockfiles used for that release. Include all required license texts, copyright notices, attributions, and source-availability statements with the distributed application or installer.

This file highlights selected runtime dependencies; it is not a substitute for the complete per-release inventory.
