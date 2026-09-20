---
name: boat-sandboxes
description: Create and manage Boat.dev sandbox machines in BB; diagnose Boat enrollment, sleep, wake, and uncertain allocations.
---

# Boat sandboxes

Boat is a BB machine provider and a project-checkout environment composition.
The Boat CLI runs on the BB server and uses that machine's Boat login.

1. Run `bb boat doctor --json` to check CLI access, billing limits, and retention.
2. Select **Boat sandbox** when starting a project thread, or create a standalone
   machine with `bb machine create --provider boat-sandbox --json`.
3. Use `bb machine suspend <id>`, `bb machine resume <id>`, and
   `bb machine remove <id>` for coordinated lifecycle operations.
4. Inspect problems with `bb boat inspect <id> --json` and `bb boat allocations --json`.

Settings live in Settings → Plugins → Boat Sandboxes. CLI examples:

```sh
bb plugin config boat-sandbox set scope personal
bb plugin config boat-sandbox set environment base
bb plugin config boat-sandbox set snapshot my-template
bb plugin config boat-sandbox set idleMinutes 30
```

Machine inputs can override `snapshot`, `environment`, and `machineType`:

```sh
bb machine create --provider boat-sandbox --inputs '{"snapshot":"my-template","machineType":"default"}' --json
```

BB owns project checkout, setup hooks, daemon installation, enrollment, and server
access. A remotely reachable server-access provider such as BB Connect must be
configured. Boat's environment/template must provide Node 22+, npm, curl and git.
Agent authentication comes from BB provider setup or the selected Boat environment;
this plugin never copies local Codex/Claude credentials. Do not use templates that
already contain an enrolled BB daemon identity.

The runtime lease defaults to 3600 seconds and is renewed by BB. Idle machines
sleep after 30 minutes; 0 disables idle sleep. If BB is offline, Boat's TTL can
stop the machine without BB's drain. On restart the maintenance sweep reconciles
stopped machines. App processes need restarting after wake; disk snapshots do
not preserve running processes. Keep persistent data under `/home/user` and ensure
it is readable by the sandbox user. Do not exclude BB identity/workspace files
with `.boxignore`. Boat delete-on-stop must be disabled.

Like the Modal provider, machines are ephemeral: removing their last live thread
can delete the sandbox and its ordinary snapshots. Named templates are not deleted.

## Prepared templates and hooks

A template may install `~/.config/bb-boat/prepare`, which BB runs after the
filesystem restore and before enrolling or reconnecting the daemon, and
`~/.config/bb-boat/before-suspend`, which runs before Boat snapshots. Hook
failure fails the lifecycle operation. Inspect or run the failing hook on the
machine; never print credentials while troubleshooting. Templates commonly
start a database detached from the prepare hook and provide a wait command;
read the machine's `~/.bb-machines/<server-host>/AGENTS.md` for its name and
run it before database work. Boat TTL stops bypass BB's shutdown hook, so data
must also support crash recovery.

A template can also carry the project checkout at BB's default path
(`~/.bb-machines/<server-host>/checkouts/project-<project-id>`, adopted instead
of cloned when its origin matches) and the server's `bb-app` build with its
digest (the installer then skips download and `npm install`). Rebuild such a
template after a BB upgrade or large lockfile changes. Every create/resume logs
one timing line (`preflight`, `sandbox`, `prepare`, `daemon`) to the
provisioning transcript and `bb plugin logs boat-sandbox`; use it to compare
templates.

## Agent authentication

`bb boat doctor` does not check Codex/Claude login. The default `base` environment
may have none. A daemon connection and a successful checkout do not prove an
agent can make an authenticated request.

For Codex 401 errors, inspect `codex login status` on the affected machine without
printing credential files. Resume a sleeping machine, then open its login terminal:

```sh
bb machine resume <machine-id>
bb terminal create --machine <machine-id> --cwd /home/user --title 'Codex sign-in' --command 'codex login --device-auth' --json
bb terminal output <terminal-id>
```

Give the user the device URL/code and wait for their browser authorization.
Verify login, then retry the existing failed turn when authorized. Do not start a
new BB thread merely to test credentials. HTTPS/WebSocket fallback cannot fix
missing authentication.

Verify login after sleep/wake; an older generic sandbox lost its login on restore
despite agent credentials being enabled. For new machines, select both
an authenticated template and its matching Boat environment; leave that
environment's agent credentials enabled. Never save an enrolled BB identity into
a reusable template, or copy desktop credential files without authorization.

## Uncertain creation

Boat has no create idempotency key. The plugin stores allocation intent before
creating and checkpoints the first returned sandbox ID. After a lost response,
it blocks retries from allocating another sandbox.

Run `bb boat allocations --json`, then `boat --org <saved-scope> list --all`.
For a suspected running sandbox, `bb boat recover <allocation-key> <sandbox-id>`
verifies its `BB_BOAT_ALLOCATION_KEY` marker before adopting it for recovery/cleanup.
If stopped, resume it with Boat first to verify the marker. After confirming no
sandbox was created, or deleting the matching orphan, run
`bb boat clear-pending <allocation-key> --confirmed-no-sandbox`.
This retires the allocation key permanently; create a new machine afterward.
Never clear uncertain intent without checking the saved billing scope.

Use `bb machine retry-cleanup <id>` after recovering an allocation for a failed
launch. Boat operations always use the resource's original scope, even after the
plugin's default scope changes. If login switches to another account, restore the
original login before lifecycle operations.

## App previews

Use `bb boat dev` in a Boat thread to run `mise run dev` in a BB terminal, discover
Rails' assigned Pitchfork port, privately host it through Boat, and open it in the
thread's normal sidebar browser. No repo-specific preview script or BB Connect
share is needed. For an already-running app use `bb boat preview`. Select another
Pitchfork daemon with `--daemon web`, or pass `--port 5173` for a different toolchain.
`bb boat dev --command 'npm run dev -- --host 0.0.0.0' --port 5173` starts a custom
command. Do not start another development process if the app is already ready.

Run with `--thread <id>` when the CLI has no thread context. With multiple desktop
windows, pass `--browser-host <id>` and `--browser-instance <id>` from
`bb browser instances`; never guess which window the user is using.

The app must bind `0.0.0.0` and allow its Boat hostname. These app settings remain
in the repository. Normal output omits the private token. Use `bb boat preview
--url` only when the user needs the coworker-sharing URL; keep it out of logs and
public messages. Coworkers need the URL and the app's own login, not a BB login.
`bb boat preview-stop` hides plugin-created routes without stopping development.
The minute maintenance sweep also hides owned routes after the app stops listening;
pre-existing routes are preserved. The dev terminal remains available after an
error so its logs can be inspected. A sandbox resume requires restarting the app.
