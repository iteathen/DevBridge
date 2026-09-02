# DB-HO131 — issue #417 Ubuntu APT transaction solver

Date: 2026-09-02

Status: local implementation and qualification complete; hosted acceptance pending

Coordinates with: #197, #417, DB-003, DB-008, DB-009, DB-017, DB-019, DB-020, and DB-HO129 through DB-HO130.

## Accepted predecessor and exact remaining seam

DB-HO130 merged through PR #454 as exact Stage 8 head `874a52a8a54d140bc27d9d7d03f6f3a8e1e2721c`. Its integrated tree exactly matches the qualified candidate tree `d2d310d796b3961022515c31e3aef50dfb50e5fa`; candidate run `33646139099` and fresh post-integration run `33646646383` each passed all four Ubuntu/Windows smoke and full jobs.

The accepted sealer can verify Canonical's signed metadata/index/binary/source chain and sign a complete DB-HO129 capsule. It deliberately cannot decide which package transaction is complete. The current construction authority still derives a snapshot from wall-clock time, resolves only seven top-level versions, and leaves both upgrade and dependency downloads on the live construction path.

## Ownership and overlap assessment

Issue #417 remains the sole owner of release-time Ubuntu capsule production and availability. #197 owns consumption of an already sealed capsule while constructing the production image. #178 owns image encoding/cache reconstruction; #192 and #200 own image publication/distribution. DB-HO130 owns verification and sealing.

DB-HO131 owns only:

```text
one caller-selected exact snapshot
+ one immutable private APT index/base-dpkg state
+ one bounded requested-package name set
  -> APT's no-removal upgrade selection
  -> one combined exact-version install solution
  -> canonical base/result package states and selected download set
  -> DB-HO129 transaction value
```

It does not select or fetch a snapshot, update indexes, download packages or sources, verify Canonical signatures, seal/upload/publish a capsule, install packages, run setup, elevate, construct an image/VM, or change a host. The next release-capture composition will map this solution through the accepted signed indexes, acquire all selected `.deb` and corresponding source objects, and pass the result to DB-HO130. #197 will later consume only that accepted sealed result.

## Primary-source research and reassessment

APT documents `--with-new-pkgs` as the upgrade mode that permits new dependencies but never package removal, and documents simulation output as `Inst`, `Conf`, and `Remv` dpkg-operation lines: <https://manpages.debian.org/testing/apt/apt-get.8.en.html>.

APT's implementation passes `FORBID_REMOVE_PACKAGES` for upgrade-with-new-packages. It uses the same command-line cache manipulation and resolver path as installation: <https://sources.debian.org/src/apt/1.8.2.3/apt-private/private-upgrade.cc>.

The low-level `python-apt` API exposes `DepCache`, `ProblemResolver`, `PackageRecords`, and archive acquisition, but its documented `DepCache.upgrade()` boolean distinguishes only ordinary upgrade from removal-permitting dist-upgrade; it does not expose APT's exact allow-new/no-remove flag pair: <https://apt-team.pages.debian.net/python-apt/library/apt_pkg.html>.

The smallest correct adapter therefore does not recreate Debian dependency solving or approximate the flag semantics. It invokes the qualified `apt-get` executable with the documented flags against an explicit read-only private state. It first obtains the upgrade-only plan. It then makes one combined install simulation containing every exact first-phase selection plus the requested tools. That second plan is the complete closure and must preserve the first plan exactly.

## Nested LEGO design

1. A pure Debian-control parser canonicalizes only `install ok installed` package/version/architecture tuples from the exact base status file.
2. A pure simulation parser accepts only bounded documented `Inst`/`Conf` lines, rejects any `Remv` or unknown output, and rejects duplicate package identities.
3. A pure solution normalizer proves no base identity disappears, no version goes backward, every changed result has an exact selected package, every selection appears in the result, and each requested package resolves exactly once for the target architecture or `all`.
4. A process adapter validates one direct `apt-get` executable and one direct private workspace. It disables inherited host APT configuration, supplies exact state/source/list paths, uses a minimal environment and `shell: false`, and re-observes every executable/input filesystem identity after solving.

The package-state SHA-256 is over canonical UTF-8 JSON:

```json
{"protocol":"devbridge/dpkg-installed-package-state-v1","packages":[{"package":"...","version":"...","architecture":"..."}]}
```

Packages are sorted by package, architecture, and version. The digest records the installed dpkg subject only; APT auto/manual-selection metadata is not part of the DB-HO129 package-state protocol.

## Failure, recovery, and cleanup

- The adapter performs simulation only and writes no output or cache.
- Its explicit APT configuration disables `/etc/apt/apt.conf` and `/etc/apt/apt.conf.d` inheritance. All state/source/index paths must be direct descendants of one caller-owned operation workspace.
- Configuration/status/source files must be direct single-link regular files. Source-part and index directories contain only bounded direct regular files. Symbolic, linked, nested, oversized, or changing evidence fails before authority is returned.
- APT failure, signal termination, stderr diagnostics, unrecognized stdout, removal, downgrade, phase drift, ambiguous request resolution, excessive output, or excessive argv fails closed.
- The injected `AbortSignal` is the only cancellation mechanism. No fixed execution timeout or timeout increase is added.
- The component creates no temporary file. The release-capture parent will own its exact operation root and cleanup.

## Verification plan

1. Prove canonical installed-state parsing/digesting and order independence.
2. Prove documented simulation parsing for native and `all` packages; reject removals, architecture disagreement, duplicates, and prose.
3. Prove the two APT calls use one explicit snapshot/private state, upgrade-with-new/no-remove first, then combined exact pins plus requested packages.
4. Reject phase drift, invented result changes, removals, downgrades, missing/ambiguous requested packages, failed/signalled/noisy APT, unknown request fields, linked/changing inputs, output/argv bounds, and prior-aborted requests.
5. Run the focused slice, accepted package-capsule chain, bounded preflight, architecture/product/standalone gates, exact Node.js 22.16.0 complete serialized suite, doctor, attributable-artifact cleanup, all four PR jobs, exact merge/tree equivalence, and a fresh all-four Stage 8 run.

This slice does not produce a real capsule. Hosted Ubuntu qualification must additionally exercise the real `apt-get` adapter against a disposable private package universe before DB-HO131 can be accepted.

## Local implementation and qualification checkpoint

The implementation keeps the dependency-policy decision in one release-side adapter and keeps parsing, canonicalization, and proof obligations as small pure functions. The adapter invokes `apt-get` twice against the same immutable private evidence: `upgrade --with-new-pkgs --no-remove`, followed by one `install --no-remove --no-install-recommends` transaction containing every exact first-phase selection and the requested package names. It disables inherited host APT configuration and cache state, constrains input topology and sizes, bounds process output and argv, re-observes every input identity and directory inventory, and returns only a normalized DB-HO129 transaction value. It adds no fixed timeout.

Local focused and accepted-package-chain coverage passes 23 total / 22 passed / one expected hosted-Linux skip. Exact Node.js 22.16.0 qualification passes bounded preflight at 3 standalone artifacts / 275 syntax files / 2 JSON files / 217 selected test files; the architecture/product/standalone subset passes 7/7; and the complete serialized suite passes 2,227 total / 2,205 passed / 22 expected skips / zero failed or cancelled in 363.670 seconds. Exact doctor is green and truthfully reports repository execution unavailable because no local persistent-environment route is materialized.

Attributable cleanup resolved 626 direct Temp roots created after the qualification runtime was introduced, measured 11,241 files / 167,116,280 bytes, unlinked all 24 test-created junctions before recursive removal, and verified zero matching residual roots. The temporary Node.js runtime and extraction scratch are absent. The unrelated live `uci_arena_background_resource_lease` directory remains present and untouched. No setup, UAC, protected-host, service, ACL, PATH, provider, image/VM, package download, capsule, construction, or physical-host action occurred.

The remaining acceptance gate is hosted CI: the Ubuntu job must run the real disposable private-APT-universe test, and all four Windows/Ubuntu smoke and full jobs must pass before integration. A real captured and sealed package capsule remains a separate subsequent LEGO.

The first hosted run `33651874567` reached the real Ubuntu fixture and failed before solving because APT's local `file:` transport represented a list entry as a symlink. That representation is valid as a transport optimization but is not valid captured evidence under this adapter's direct-file contract. The correction is confined to the test producer: after `apt-get update`, it replaces each local-transport list symlink with the bytes it references and asserts that the entire captured-list inventory is now direct regular files. The production adapter remains strict and unchanged.

The second hosted run `33652253489` then reached the first real simulation and exposed an APT-version compatibility error. Ubuntu 24.04 supplies APT 2.8.3: its `apt-get` interface documents `--snapshot`, `--no-remove`, and simulation, but does not define the newer `--no-list-columns` presentation switch. That switch is unnecessary for APT 2.8's documented `Inst`/`Conf` simulation grammar, so the adapter removes only it and retains exact snapshot and no-removal arguments. A focused argument assertion prevents reintroducing the unsupported option.
