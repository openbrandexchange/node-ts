# Browser tests (Playwright)

`e2e/run.sh` starts a fresh node-ts (Bun) on a temporary data directory and walks the real admin
screens and retailer portal (the vendored admin-ui in `public/`) in headless Chromium:

- first-run setup, import of the Kestrel fixtures (CSV + zip), access request → approval → invitation,
  retailer sign-in, catalog, article page, EAN list, selection zip, background zip, article data CSV,
  API keys (brand-made and self-service), access keys, a scheduled import from a web address,
  the Dutch portal ("Beeldbank");
- **accessibility**: axe-core (WCAG 2.1 A + AA) on every main portal and admin screen, the setup
  wizard, sign-in, request access and forgot password;
- **keyboard**: signing in and opening an article with the keyboard only, with a visible focus ring.

```sh
e2e/run.sh                       # needs Bun, Node.js and zip; installs Playwright's Chromium on first run
e2e/run.sh -g "keyboard"         # extra arguments go to playwright test
OBX_E2E_AXE_SOFT=1 e2e/run.sh    # print every axe violation of the walk instead of failing on the first
```

Screenshots land in `e2e/screenshots/`, traces of failures in `e2e/test-results/`.
Accessibility problems found here are fixed in the admin-ui repository, then vendored with `scripts/update-ui.sh`.
