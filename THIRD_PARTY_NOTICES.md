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

## Release inventory

Before publishing a binary release, generate and review a complete third-party license inventory from the exact npm and Cargo lockfiles used for that release. Include all required license texts, copyright notices, attributions, and source-availability statements with the distributed application or installer.

This file highlights selected runtime dependencies; it is not a substitute for the complete per-release inventory.
