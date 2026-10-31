# Contributing

This repository is in early development and distributed under MIT. Please discuss substantive changes in an issue before submitting a pull request.

1. Use Node.js 22+ and `npm ci`.
2. Run `npm run check` on a clean checkout.
3. Develop using synthetic sample files; never upload personal/corporate data.
4. Keep all new capabilities deny-by-default, explicitly scoped, and tested for denial paths.
5. Open a focused PR with security impact, tests, and documentation.

Do not weaken access checks, add network listeners, or allow arbitrary shell commands as a convenience shortcut. Security-sensitive changes require owner review.
