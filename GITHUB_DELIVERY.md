# GitHub delivery — 7 October 2026 (Asia/Bangkok)

Target: existing repository `https://github.com/CosMD-BBB/Warehouse_Management`, branch `main`.

Native Git reads succeeded and confirmed the remote had no refs before delivery. The initial source push succeeded at commit `890c5c3cf67f6a20977b0cc1b457f0f2cee2fac2`; a native Git read of the canonical repository confirmed the same commit on `main`. GitHub reported that the original `warehouse` repository had moved to `Warehouse_Management`, so the existing remote was updated to that canonical URL. No repository visibility change or replacement Site is requested. GitHub API calls through `gh` returned `Forbidden`; API access and hosting-provider access remain unavailable; GitHub Actions execution status therefore has not been verified in this Cloud configuration. Network policy was not modified.

The source includes the real Node 24 backend, SQLite storage code, all 21 frontend assets, all five current test suites, Docker configuration, and GitHub Actions for backend tests. Upload excludes `.local`, SQLite files/WAL/SHM, credentials, environment files, sessions, generated QA output and customer exports. A new persistent hosting database must be configured by the chosen provider; no user database is in this delivery.

The Docker image built successfully, all 21 cases also passed inside the Node 24 container, and the actual container startup was checked with provider-style `PORT=4300`: first-run setup remained available, representative assets loaded, anonymous state and forged Host were rejected, and no account was created. The temporary smoke container was stopped.

Tests before delivery: 21/21 cases passed (17 existing API cases plus 4 hosting guards). New hosting tests verify strict configured HTTPS origin/Host, Secure cookies, retained authentication/CSRF/private-file guards and rejection of spoofed forwarded headers. Local proxy simulation is not a live HTTPS deployment.

Website publication is pending a supported backend hosting target and authorized access to it. No GitHub Pages deployment is used because it cannot run this backend. No new Site or external hosting service was created, and no live website URL is claimed. See [HOSTING.md](HOSTING.md) for the prepared deployment contract.

The original received-archive checksums remain in `CLOUD_PACKAGE_MANIFEST.json`. They describe the original ZIP before documented QA and hosting changes, not the current Git commit. See [CLOUD_QA_RESULTS.md](CLOUD_QA_RESULTS.md) for previous browser verification and screenshots.
