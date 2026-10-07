# GitHub delivery — 7 October 2026 (Asia/Bangkok)

Target: existing repository `https://github.com/CosMD-BBB/Warehouse_Management`, branch `main`.

Native Git reads succeeded and confirmed the remote had no refs before delivery. The initial source push succeeded at commit `890c5c3cf67f6a20977b0cc1b457f0f2cee2fac2`; a native Git read of the canonical repository confirmed the same commit on `main`. GitHub reported that the original `warehouse` repository had moved to `Warehouse_Management`, so the existing remote was updated to that canonical URL. No repository visibility change or replacement Site is requested. GitHub API calls through `gh` returned `Forbidden`; API access and hosting-provider access remain unavailable; GitHub Actions execution status therefore has not been verified in this Cloud configuration. Network policy was not modified.

The source includes the real Node 24 backend, SQLite storage code, all 21 frontend assets, all five current test suites, Docker configuration, and GitHub Actions for backend tests. Upload excludes `.local`, SQLite files/WAL/SHM, credentials, environment files, sessions, generated QA output and customer exports. A new persistent hosting database must be configured by the chosen provider; no user database is in this delivery.

The Docker image built successfully, all 21 cases also passed inside the Node 24 container, and the actual container startup was checked with provider-style `PORT=4300`: first-run setup remained available, representative assets loaded, anonymous state and forged Host were rejected, and no account was created. The temporary smoke container was stopped.

Tests before delivery: 21/21 cases passed (17 existing API cases plus 4 hosting guards). New hosting tests verify strict configured HTTPS origin/Host, Secure cookies, retained authentication/CSRF/private-file guards and rejection of spoofed forwarded headers. Local proxy simulation is not a live HTTPS deployment.

Website publication is pending a supported backend hosting target and authorized access to it. No GitHub Pages deployment is used because it cannot run this backend. No new Site or external hosting service was created, and no live website URL is claimed. See [HOSTING.md](HOSTING.md) for the prepared deployment contract.

The original received-archive checksums remain in `CLOUD_PACKAGE_MANIFEST.json`. They describe the original ZIP before documented QA and hosting changes, not the current Git commit. See [CLOUD_QA_RESULTS.md](CLOUD_QA_RESULTS.md) for previous browser verification and screenshots.

## Browser-based demo setup

The repository now includes a Node 24 dev container and an automatic Codespaces launcher, linked from the README. The deep link opens GitHub's Codespace creation/resumption page; it is not a deployed website URL. The owner must sign in and create or resume a Codespace. Port 4180 remains private by default and opens the actual backend, with a separate `.local/codespaces-demo.sqlite` database and owner-chosen first-run Admin credentials.

The launcher sets one exact HTTPS origin from GitHub's provided forwarding hostname. It does not weaken Host/Origin validation or change port visibility. Tests exercise its configuration checks and real backend startup locally; no live Codespace has been created or verified from this Cloud runtime. Provider forwarding, GitHub access, quota and actual browser Login still require verification on the owner's Codespace. This is a temporary demo route, not permanent hosting, and the original Site ID remains unchanged. See [CODESPACES.md](CODESPACES.md).

Validation for this addition: `npm test` passed 27/27 cases on the Cloud Node 24 runtime and again in the rebuilt Node 24 Docker image. The six launcher cases cover configuration conflicts, retained authentication and Secure cookies, concurrent starts, restart persistence, unrelated listeners/PIDs, failed marker-write cleanup and refusal of linked storage paths. Launcher lifecycle cases require Linux and explicitly skip on other systems; original backend tests continue to run. The dev container's common fields passed the official base schema check. These results do not verify a live GitHub Codespace or a public website.
