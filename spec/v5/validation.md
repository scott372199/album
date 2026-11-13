# V5 前端验证记录 / Frontend Validation Record

## T-07 阈值 / Thresholds

| Area | Acceptance threshold | Evidence |
| --- | --- | --- |
| First screen | Hero has a source or an explicit empty state; no blocking remote font or external asset | `index.html`, `verify` |
| Hero motion | `prefers-reduced-motion` and low-performance fallback keep content visible | `main.js`, `style.css` |
| Search interaction | URL state is updated; keyboard-accessible input and buttons; zero results explain recovery | `state.test.mjs`, `index.html`, `main.js` |
| Photo media | Images use `object-fit: contain`; lazy loading is used for catalog media | `style.css`, `gallery.js` |
| Accessibility | Skip link, labelled navigation/dialogs, live status regions, native buttons, and visible focus styles | `index.html`, `style.css` |
| Android WebView | No required browser-only API is used for the search fallback; native back bridge remains optional | `main.js`, `native.js` |
| Offline checks | `npm test`, `npm run verify`, and `npm run check:repo` must pass | 75 tests, 38 checks, repository scan passed |

## Result / 结果

- Static checks passed.
- `npm run build:web` passed after installing the platform-compatible `sharp` runtime.
- Frontend artifact footprint is `192K` total (`164K` assets, 13 asset files).
- Browser smoke check passed: `lang="zh-CN"`, labelled navigation and dialogs, skip-link target,
  sequential Tab focus, search query URL encoding, explainable `2025 年` empty state, live
  status region, and `prefers-reduced-motion` detection.
- Real Android WebView timing was not available in this environment; compatibility is covered
  by the no-optional-API search fallback, native bridge isolation, and static checks.
