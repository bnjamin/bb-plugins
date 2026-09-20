# Validation — 2026-09-19

- Installed and running in BB 0.43.3 with public Plugin SDK 0.4.104.
- `bb boat doctor --json` passed for the authenticated Personal account and
  default `base` environment.
- Machine provider and Boat sandbox/project-checkout composition appear in BB's
  live provider inventories, accept empty inputs and advertise suspend support.
- Typecheck, 20 automated tests and `bb plugin build` passed. Tests cover BB
  fake-host registration, real SQLite allocation storage, lifecycle recovery,
  account/scope protection, maintenance ordering, command privacy, cancellation,
  public API imports, and the lazy-filesystem restore guard.
- Boat CLI account fingerprint lookup passed without printing the account identifier.

## Live BB enrollment and lifecycle

Disposable machine `host_jta2kcwafd` / Boat sandbox `bx_8kw42ygv`:

1. Created through `bb machine create --provider boat-sandbox` with default inputs.
2. Installed/enrolled the BB daemon and connected through BB Connect.
3. Wrote a marker using BB's file API.
4. Suspended through BB's coordinated lifecycle; Boat confirmed its saved snapshot.
5. Reproduced and fixed the restore guard bug below, then reconnected.
6. Ran a fresh BB suspend/resume cycle with the corrected guard.
7. Confirmed the same BB host and Connect machine identity returned connected.
8. Read the original marker through BB's file API; content and SHA-256 were unchanged.
9. Removed the machine through BB; its Boat sandbox was deleted and tracked
   allocations returned to zero.

The actual project checkout/agent-start flow and visual picker were not exercised;
composition registration was verified through BB's provider API. No test thread
was spawned and no existing project source was changed.

## Restore bug fixed during live validation

Boat marks its lazy restore mount with SOURCE `ascii-lazyfs`; FSTYPE alone does
not identify it. The original guard checked FSTYPE and proceeded too soon. A
populated-directory rename then hid its child file (`cat: .../after/file: No such
file or directory`).

The plugin now checks SOURCE, fails closed if mount inspection fails, waits for
replacement, and only then probes a populated-directory rename. A regression test
with a mocked mount source failed before the fix and passes afterward. The fresh
installed-plugin sleep/wake cycle passed with this change.

## Earlier transport checks

Disposable sandbox `bx_axmvbska` passed create, SSH/tool preparation, snapshot stop,
resume, file persistence and allocation-marker verification, then was deleted.
Earlier attempts `bx_pa9zymtg` and `bx_enm7ebze` were also deleted. The first hit the
local execution sandbox's SSH access boundary; the latter exposed the restore
issue subsequently reproduced and fixed above. No named template was modified.

## Agent authentication follow-up

The first user project thread completed checkout but failed its Codex request with
`401 Missing bearer or basic authentication`. Inspection of that machine found
no Codex auth file, no OpenAI/Codex API-key environment variable, no custom model
provider, and `codex login status` reported not logged in. Its Boat environment
was `base`, with no authenticated template selected.

Machine connectivity tests do not validate agent authentication. README and the
agent skill now include explicit device-login setup and guidance for authenticated
templates. Device login completed successfully on the affected machine. Retrying the
existing failed turn produced a new assistant response and normal token usage,
confirming that the missing-authentication error is resolved.

A generic machine later reported `Not logged in` after a wake check with
`~/.codex/auth.json` absent, although its environment had agent credentials
enabled and third-party-safe mode disabled. Credential persistence across
sleep/wake therefore needs verifying per template.

## Template hooks (2026-09-19)

- Added optional sandbox-local prepare and before-suspend Bash hooks. Tests verify
  that filesystem hydration precedes service startup, failed startup prevents
  readiness, and failed database shutdown prevents snapshotting.
- Live check with a project template that runs a database from the prepare hook:
  wrote a marker row, suspended/resumed through BB, and read the same marker after
  the automatic restart. The machine kept the same BB/Connect identity across the
  cycle.
- A machine enrolled from an unenrolled named template started with the database
  already running and completed the project's setup script in 7.7 s from warm
  caches. Its snapshot inventory was verified to hold no BB enrollment and no
  injected credential files. Builder and validation sandboxes were deleted.

## App preview migration

- Added `bb boat dev`, `bb boat preview`, and `bb boat preview-stop` using public BB APIs.
- Typecheck passes; 31 tests pass, including private URL validation, machine/account ownership, assigned-port discovery, browser selection, terminal readiness and cleanup.
- No native browser proxy, stream, or BB core change is involved.
- The private URL is returned only with `--url`; stored route records contain no tokens.

## Launch time — 2026-09-20

Baseline from BB's provisioning events for two launches of a Rails project with
a ~230 MiB repository (271,846 objects) and a database service, one from a 3.8 GB
warm template and one from the bare `base` environment. Seconds from
`thread/start`; each step includes everything up to the next.

| Step | warm template | `base`, no template |
| --- | ---: | ---: |
| Title generation (core) | 2.1 | 0.0 |
| Preflight (`Creating Boat…`) | 1.0 | 1.6 |
| `boat new` until ready | 8.7 | 2.0 |
| Filesystem guard + prepare hook (database start) | 51.4 | 1.0 |
| Prepare enrollment | 2.0 | 3.0 |
| Bootstrap (download bb-app, `npm install`, join) | 17.0 | 15.0 |
| Full `git clone` of the project | 15.5 | 16.6 |
| Workspace ready → thread started | 10.3 | 8.5 |
| **Total** | **108** | **48** |

The warm template made launches slower, not faster: Boat's lazy restore of the
snapshot plus a synchronous database start cost ~50 s, while what it saved (the
setup script in 7.7 s instead of minutes) lies outside the launch path. The
clone and the daemon install were paid on every launch regardless of template.

Changes in this revision, all covered by typecheck and the test suite:

- `preflight` runs its two Boat calls concurrently; create runs preflight and
  the account lookup together and reuses that client for preparation and
  enrollment (three fewer sequential CLI round trips).
- The filesystem guard and the prepare hook share one SSH session; hook stdout
  stays private, its stage is marked so a hook failure is still reported as
  such, and the guard/hook split is reported to the transcript.
- Create and resume log one timing summary (`preflight`, `sandbox`/`resume`,
  `prepare`, `daemon`) to the transcript and `bb plugin logs boat-sandbox`.
- README documents the two BB core behaviors a template can exploit: checkout
  adoption at the default path, and the installer's 304 shortcut for a
  pre-installed `bb-app` with its recorded digest.

Expected effect: the clone (~15 s), most of bootstrap (~12 s of 17 s) and any
synchronous service wait leave the launch path. Boat hydration of the snapshot
remains the largest and most variable step.

### Live result with a template built that way (2026-09-20)

`bb machine create --provider boat-sandbox` against a 3.9 GB template carrying
the checkout, finished setup, hooks and pre-installed `bb-app`:

| Stage | Before | After |
| --- | ---: | ---: |
| preflight | 1.0 | 0.5 |
| sandbox (`boat new` until ready) | 8.7 | 73.6 |
| prepare (filesystem guard + hook) | 51.4 | 17.3 |
| daemon (bootstrap + join) | 17.0 | 8.3 |
| **machine ready** | **78** | **99.6** |

On the machine, the checkout sat at BB's default path with the project's origin,
clean and already at `origin/master`; the database had come up in the background;
the artifact digest was recorded. Every launch-path change worked as intended.

The sandbox stage regressed for a reason outside the plugin: Boat's create API
was slow all day. Its CLI timed out client-side (~30 s, "could not reach the
Boat API … operation timed out") on three of four creates, while Boat still
created each sandbox within a second of the request. Snapshot size was not the
cause (3.91 GB vs 3.82 GB; the old template timed out the same way). The plugin
now handles this: after a create fails without an ID it lists new sandboxes,
verifies the `BB_BOAT_ALLOCATION_KEY` marker over `boat exec`, and adopts the
match instead of leaving an uncertain allocation. One earlier launch before that
change did end uncertain and was reconciled with `bb boat recover` and
`bb machine retry-cleanup`; no sandbox leaked. Thread-level checkout adoption is
exercised by core on the first thread start and was not part of this run.

## Share test-drive fixes (2026-09-20)

- Plain `bb boat share` on the existing application Boat thread returned only the
  origin, token-withheld guidance, and the actual desktop host/instance.
- Explicit JSON retained the private URL. An in-memory cookie-jar request
  followed its authorization redirect and received HTTP 200 with the application
  login title and CSRF metadata. No token was printed or saved in this report.
- The browser operation reported `reused` on the Mac desktop. That host's
  `bb browser instances` listed the same instance; the Boat machine listed none.
- Before repair, `bwrap --unshare-net --dev-bind / / true` failed with
  `Failed RTM_NEWADDR: Operation not permitted` and Ubuntu's userns sysctl was 1.
  Applying the plugin's preparation script changed it to 0 and both the
  network-namespace and user-namespace bubblewrap checks exited successfully.
- The repair writes `/etc/sysctl.d/99-bb-boat-userns.conf` inside Boat. The plugin
  also runs it before the template hook on every create/resume, so old named
  templates benefit without being rebuilt from an enrolled machine.
- The existing application preview remains available. No stop, suspend, or template
  replacement was performed. A full sleep/wake was not exercised in this run.
- All 44 tests, TypeScript checking, and the plugin build passed.

## General development configuration

- Removed the project-specific host worker, layout checks, environment-file
  edits, and repository-script startup. Share now uses the generic preview path.
- Global command, port, and daemon defaults are plugin settings. Project-ID
  overrides live in the same settings; CLI flags take precedence.
- 43 tests, typecheck, and build pass, covering arbitrary ports, explicit and
  configured startup commands, inheritance, invalid settings, and token output.
- Reloaded the plugin and shared an existing application on port 3000 without
  restarting it. The generic Boat route opened successfully and repeat sharing
  reused its tab.
- HTTP validation of the new `*.on.boat.dev` route returned 403 from the
  application's host allowlist. The plugin does not change app host authorization;
  apps must permit the Boat hostname as documented.
