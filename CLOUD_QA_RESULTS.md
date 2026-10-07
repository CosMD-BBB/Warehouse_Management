# Cloud verification — 7 October 2026 (Asia/Bangkok)

The authenticated runtime file reference was materialized successfully. The received `WMS_Software_Cloud.zip` is 2,213,373 bytes and has SHA-256 `9e2a4851ecccca289208d9316f7f5c2f0898f847098dbebcba90166c01fa2ba5`. Safe extraction confirmed 37 files, including 21 public assets. Before any edits, every size and hash in `CLOUD_PACKAGE_MANIFEST.json` matched. That manifest describes the received archive; subsequent code changes below intentionally differ from its original checksums.

## Runtime and external preview

Node v24.19.0 is installed. `npm start` runs the actual `server/index.mjs` backend. A new private demo database was initialized at `.local/cloud-preview.sqlite`; it still reports `needsSetup: true` and has no preconfigured admin. User credentials must be chosen through setup. QA accounts were created only in separate temporary fixture databases and removed after the checks.

The sandbox initially rejected loopback listeners with `listen EPERM`. Authorized execution through the runtime's approval mechanism allowed the tests and backend to run; network policy was unchanged.

This chat exposes no Preview, inbound port forwarding, or external website URL capability. The verified loopback server cannot be opened from the user's device. No public preview or permanent publication is claimed. Host/origin validation, authentication, CSRF, tenant isolation and role checks remain enabled. No speculative public hostname or trusted proxy configuration was added.

All 21 HTML/CSS/JS/image/font assets return 200 with their actual byte sizes. Anonymous `/api/state` returns 401, unapproved Host and cross-origin setup return 403, and private source/seed/database paths return 404. The backend was restarted after changes and remains in first-run setup.

## Changes made after receiving the archive

- `server/model.mjs`: marketplace order edits preserve their existing Shopee, Lazada or TikTok Shop channel; channel reclassification is rejected before reservations change. Creating marketplace orders through the manual form remains rejected.
- `dist/order-editor.js`: show and lock the original marketplace channel, including after a failed save. Switching from order detail to the editor now removes the previous dialog class, restoring the intended editor width.
- `qa/order-entry.test.mjs`: regression coverage for edits across all three marketplaces, preservation of external identity and stock reservations, and rejection of forged channel changes.
- `dist/app.js`: format dates explicitly in Asia/Bangkok, avoiding a one-day shift in UTC and other browser timezones.
- `dist/auth-client.js`: fix the four HTML username patterns for modern Chromium validation without changing server username rules.

## Validation executed on this source

The original four API suites passed 16/16 cases before changes. Final `npm test` passed **17/17 cases, fail 0** after the added marketplace regression and all fixes. Existing authentication and workflow suites also reported 38 and 26 internal checks. Persistence and legacy migration were tested using fixtures only.

Chromium 151 browser QA ran against real fixture backends:

- Authentication/store/role coverage: 39 passing checks, plus a separate Warehouse inventory CSV check through its visible button. Setup and login, desktop/mobile, user creation, separate stores with identical usernames, empty new-store stock/orders/finances, unchanged provisioning session, shared-cookie tabs and delayed responses were checked. Warehouse responses include delivery contact/address/items without money fields; Finance reports export through the UI and denied inventory/member APIs return 403. Logout revokes access.
- Date checks: all eight preset buttons, expected Bangkok bounds, and complete daily/monthly chart periods including zero-sales dates. Date formatting was verified in UTC, Asia/Bangkok and America/Los_Angeles.
- Order editor coverage: eight passing checks on desktop 1440×1000 and mobile 390×844. Two SKU lines, Thai phone digits, separate billing/shipping addresses, decimal discounts/shipping and total 265 baht, manually confirmed payment, postcode correction, atomic failed/successful reserved edits, all three locked marketplace channels, mobile product add/remove/duplicate aggregation, and free Review reservation were exercised. No horizontal overflow or uncaught JavaScript exceptions occurred in these flows.
- Warehouse dispatch CSV was checked through the existing browser exporter helper; there is no export button on the Warehouse orders header. This is distinct from the visible Warehouse inventory and Finance report export buttons.

These results cover the listed flows. They are not a claim that real marketplace/carrier/payment integrations or every print and fulfillment browser flow have been verified.

## Actual screenshot artifacts

Captured from the real authenticated fixture backend using fictional data; password inputs are blank in login captures. These files are screenshots, not remotely usable website links:

- `/workspace/order-hub-qa-artifacts/login-desktop.png`
- `/workspace/order-hub-qa-artifacts/dashboard-desktop.png`
- `/workspace/order-hub-qa-artifacts/order-editor-desktop.png`
- `/workspace/order-hub-qa-artifacts/stores-desktop.png`
- Mobile and first-run setup variants are in the same artifact directory.

Machine-readable evidence: `backend-checks.json`, `auth-browser-qa-report.json`, `warehouse-inventory-export-results.json`, and `editor-qa-report.json` in that directory. QA scripts are outside the application checkout under `/tmp`.

## Continuing the backend locally in this environment

Use the existing source at `/workspace/order-hub`; no dependencies need installing. Run `ORDER_HUB_DB=/workspace/order-hub/.local/cloud-preview.sqlite npm start` with authorized loopback access if sandboxed. Do not start a second process on port 4180. Check `/api/auth/status` internally without creating an account on the preview database. Stop only the server instance you started when a restart is necessary. Live processes may not survive a future session.

External preview still requires a supported runtime forwarding capability and a verified HTTPS origin before any host/origin or secure-cookie adaptation. Preserve Site ID `appgprj_6ac5d357e9988191916bd6f86d096ad3`; do not create a replacement Site or publish `dist` alone.

The user's actual local database was neither received nor migrated. Platform OAuth, bank/slip verification, carrier booking/tracking/labels and stock publication remain simulated or unconnected as documented in `CLOUD_HANDOFF.md`.
