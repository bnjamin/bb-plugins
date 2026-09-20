# Boat Sandboxes for BB

Run BB project threads on [Boat.dev](https://boat.dev) machines. Inspired by BB's
Modal sandbox provider.

- Machine provider and **Boat sandbox** environment picker entry.
- BB-owned checkout, setup, daemon installation, enrollment and server access.
- Snapshot-backed sleep/wake on the same Boat sandbox and BB machine identity.
- Idle sleep, runtime lease renewal and reconciliation after Boat auto-stop.
- Durable early allocation tracking, original billing scope, account checks and explicit recovery
  when a create response is lost.
- Settings UI, `bb boat` diagnostics and an agent skill. No custom frontend needed.

## Install

Requires BB 0.43+ with Plugin SDK 0.4.104+, Node 22+ on the server, and an authenticated
[Boat CLI](https://docs.boat.dev/quickstart) on the **BB server machine**.
Boat is found on PATH or at `~/.ascii/bin/boat`; `cliPath` overrides that lookup.

```sh
npm ci
npm run typecheck
npm test
bb plugin build
bb plugin install .
bb boat doctor --json
```

Configure a remotely reachable machine server-access provider (for example BB
Connect) in BB's Machines settings. Select **Boat sandbox** when starting a project
thread. Standalone machines can be created with:

```sh
bb machine create --provider boat-sandbox --json
bb machine suspend <machine-id>
bb machine resume <machine-id>
bb machine remove <machine-id>
```

## Sign in to your agent

`bb boat doctor` checks Boat access and snapshot retention. A connected BB daemon
does not mean Codex or Claude is authenticated. The default `base` environment
can have no agent credentials, and this plugin does not copy your desktop login.

For Codex, open a terminal on the Boat machine and run `codex login --device-auth`.
Complete the browser authorization, verify `codex login status`, then retry the
failed turn. You can start that terminal from the CLI:

```sh
bb machine resume <machine-id>
bb terminal create --machine <machine-id> --cwd /home/user \
  --title 'Codex sign-in' --command 'codex login --device-auth' --json
bb terminal output <terminal-id>
```

A `401 Missing bearer or basic authentication` on both HTTPS and WebSockets is
an authentication failure; switching transports will not supply credentials.
Check login on the affected machine, not on your Mac. Never print `auth.json` or
tokens into terminal logs. See [Codex authentication](https://developers.openai.com/codex/auth).

Verify `codex login status` after sleep/wake; the older generic sandbox lost its
login during a live restore check, even with agent credentials enabled. Do not
assume successful login proves credential persistence. New machines need their
own authentication, or an explicitly selected authenticated Boat environment and
template. When using a named template, set both `environment` and `snapshot`; a
named snapshot does not carry its source environment. Keep
agent-credential injection enabled in that environment so Boat preserves its
Codex login. Prepare reusable templates before enrolling any BB daemon.

## Configuration

Settings → Plugins → Boat Sandboxes, or `bb plugin config boat-sandbox set <key> <value>`.
Changes apply to subsequent operations without reload. Existing machines retain
their original billing scope, account fingerprint and runtime lease.

| Setting | Default | Purpose |
| --- | --- | --- |
| `scope` | `personal` | Explicit Personal or organization billing scope |
| `cliPath` | automatic | Boat executable on the BB server |
| `environment` | `base` | Existing Boat named environment |
| `snapshot` | empty | Optional named template for new machines |
| `machineType` | `default` | `small`, `default`, `large`, or `xlarge`; plan limits apply |
| `ttlSeconds` | `3600` | Renewable runtime lease, 1800–7200 seconds |
| `idleMinutes` | `30` | Coordinated idle sleep; 0 disables it |

Per-machine inputs override `environment`, `snapshot` and `machineType`:

```sh
bb machine create --provider boat-sandbox \
  --inputs '{"environment":"my-dev","snapshot":"my-stack","machineType":"default"}'
```

Use Boat's existing environment and named snapshot workflow for custom toolchains.
Templates must provide Node 22+, npm, curl and git, and must never have enrolled a
BB daemon. The plugin checks the mount source for Boat's `ascii-lazyfs`, waits for
filesystem restoration to finish, and verifies a
populated-directory rename before enrollment. It does not copy local agent logins
or modify your Boat environments; configure agent credentials through BB or Boat.
No template is selected or modified automatically.

### Faster launches with a prepared template

Two BB core behaviors let a template remove the largest fixed costs of a launch:

- **Checkout adoption.** On a new machine BB looks for the project at
  `~/.bb-machines/<server-host>/checkouts/project-<project-id>` (the ID
  lowercased, non-alphanumerics collapsed to `-`). If that directory exists and
  its `origin` URL equals the project's Git remote, BB registers it instead of
  cloning. A template can carry the repository, with dependencies installed and
  setup already run; the prepare hook can fast-forward it when it is clean.
- **Daemon reuse.** BB's installer sends the digest recorded in
  `~/.bb-machines/<server-host>/host-artifact.sha256` as `If-None-Match`; when
  `npm/bin/bb-app`, `npm/bin/bb` and the daemon bundle are present under that
  directory and the server's build matches, it skips the download and the
  `npm install` of native add-ons. Install the server's `/install/bb-app.tgz`
  with `npm install -g --prefix ~/.bb-machines/<server-host>/npm` and write the
  `x-bb-artifact-sha256` header value to that file. Never write `auth.json` or
  `config.json` there; that would be an enrolled identity. Rebuild the template
  after a BB upgrade to regain the shortcut; launches keep working meanwhile.

Start services from the prepare hook detached, and give agents a wait command.
`~/.bb-machines/<server-host>/AGENTS.md` is appended to every thread's system
prompt on that machine, so it is the place to explain those commands.

Boat injects an environment's variables (for example `CLAUDE_CODE_OAUTH_TOKEN`
from its agent credentials) into SSH sessions, but BB's daemon runs as a systemd
user service and inherits the user manager's environment, which has none of
them, so agents start logged out. Either store the credential in BB with
`bb machine env set NAME` (encrypted, synced into every daemon), or have the
prepare hook run `systemctl --user import-environment NAME…` for the variables
that are set; the hook runs in an SSH session before the daemon starts on both
creation and wake.

### Launch timing

Each create and resume writes one summary line to the provisioning transcript
and to `bb plugin logs boat-sandbox`, for example
`Boat create of bx_… took 79.0s (preflight 1.0s, sandbox 8.7s, prepare 51.4s, daemon 17.0s)`,
plus the filesystem-restore and prepare-hook split. Compare these before and
after changing a template; Boat placement and hydration vary between launches,
so read several samples.

## Lifecycle and recovery

While BB is running, a minute sweep renews leases before they approach expiry and
requests idle sleep through BB's coordinated drain. Thread starts/activity and
terminal input reset the idle timer. Core may interrupt a long-running turn when
coordinating suspension, as with Modal. If BB goes offline, Boat's TTL can stop a
machine independently. The next sweep reconciles that state for resume.

Boat stop captures a filesystem snapshot and resume restores the same sandbox ID.
Processes do not survive; restart app servers and background workers after wake.
Templates may provide Bash hooks at `~/.config/bb-boat/prepare` and
`~/.config/bb-boat/before-suspend`. The prepare hook runs after filesystem
restoration and before daemon enrollment/reconnection, including on first
creation. The suspend hook runs on a running machine before Boat saves it. Each
has a ten-minute timeout; failure prevents the lifecycle operation from reporting
success. Hooks run as the sandbox user and their output is not sent to BB logs;
the prepare hook shares the filesystem guard's SSH session, and only the guard's
own timing line is read back from it. The daemon, checkout and agent all wait
behind the prepare hook, so keep its synchronous part short: fail fast on lost
data, and start slow services detached with a wait command for agents. Boat's
own TTL stop cannot run the plugin's shutdown hook; databases must also tolerate
crash recovery.
Persistent data should live under `/home/user`, readable by the sandbox user. Do
not exclude BB's files or checkout with `.boxignore`. Delete-on-stop retention is
incompatible and is rejected during preflight and suspension.

Machines are **ephemeral**, matching Modal: BB may remove them after their last
live thread is removed. Machine deletion permanently deletes the Boat sandbox and
ordinary snapshots. Named base templates remain untouched.

```sh
bb boat doctor --json
bb boat inspect <machine-id> --json
bb boat allocations --json
```

Boat offers no create idempotency key. An allocation intent is persisted before
creation, and the first JSONL `created` ID is saved before enrollment. A retry
reuses that ID. Every sandbox is created with a `BB_BOAT_ALLOCATION_KEY`
environment marker; when Boat's create call fails without returning an ID (its
CLI has been seen to time out client-side while the sandbox was still created),
the plugin looks for the single new sandbox carrying this key, verifies the
marker, and adopts it. Only when that finds nothing does the allocation stay
uncertain, blocking further allocation and cleanup rather than silently leaking
another machine. See [the agent skill](skills/boat-sandboxes/SKILL.md#uncertain-creation)
for verified recovery and clearing resolved pending allocations.

The plugin only returns allowlisted sandbox fields; desktop access URLs, account
credentials and enrollment stdin are never placed in resources or progress logs.
Commands carrying stdin suppress transport output because it may echo secrets.
A hashed account identifier prevents cleanup from mistaking a different Boat login
for a deleted sandbox. Restore the original login to manage existing machines.

## Development and validation

```sh
npm run typecheck
npm test
bb plugin build
```

See [validation results](VALIDATION.md) for tested behavior and remaining live checks.

Tests use BB's public fake host with real SQLite storage and an injected Boat
transport. They exercise partial allocation, retries, scope changes, snapshot
failure, cleanup, maintenance, secret handling and process cancellation.

An optional live check creates one disposable Personal sandbox, resumes it once,
verifies a persisted file and its ownership marker, and deletes it in `finally`:

```sh
npx tsx scripts/smoke.ts --live
```

This uses Boat compute and two starts. `BB_BOAT_SCOPE` and `BB_BOAT_ENVIRONMENT`
override its scope/environment. It saves the sandbox ID to `.smoke-resource.json`
for recovery after a process crash. This transport check does not enroll a BB
machine; test daemon enrollment through an installed plugin with reachable server
access. No tests touch existing sandboxes or named templates.

References: [BB Plugin SDK](https://github.com/get-bb/bb),
[Boat CLI](https://docs.boat.dev/cli-reference),
[Boat automation](https://docs.boat.dev/use-in-code),
[Boat snapshots](https://docs.boat.dev/snapshots).

## Development previews

From a thread on a Boat machine:

```sh
bb boat dev                         # Run mise run dev in a BB terminal and open the app
bb boat preview                     # Open an already-running Pitchfork rails daemon
bb boat preview --daemon web        # Discover a different Pitchfork daemon's port
bb boat dev --command 'npm run dev -- --host 0.0.0.0' --port 5173
bb boat preview --port 3000 --url   # Explicitly retrieve the private coworker-sharing URL
bb boat preview-stop                # Hide plugin-created routes; leave app processes running
```

Commands resolve the thread's environment, directory and sandbox through BB.
Use `--thread <id>` outside a thread. The Boat CLI runs on the BB server using the
account and scope that created the machine. No app repository script or BB Connect
port share is needed. `dev` reuses a running app; otherwise it starts a persistent
thread terminal and waits up to 90 seconds. Failed startup leaves terminal logs
available. Stop development through that terminal or the app's normal stop command.

Previews use Boat's token-protected hosting and BB's normal desktop browser, not a
streamed desktop. Apps must listen on `0.0.0.0` and accept their Boat hostname
(`*.on.boat.dev`, or the legacy `*.on.ascii.dev`). App authentication still applies.
`mise run dev` remains an ordinary repository command; automatic preview comes
from running `bb boat dev` instead. Port discovery requires mise/Pitchfork; use
`--port` with other toolchains.

Discovery searches all connected machines, including desktops separate from the
Boat execution machine. Successful responses include `browserTarget` with the
desktop host and instance. Use `bb browser instances --host <browser-host>` to
inspect it; the headless Boat machine normally has no windows. `opened`/`reused`
reports a completed desktop tab operation, not visibility in a remote web client.

Exactly one connected desktop window is selected automatically. For multiple
windows, use `--browser-host <id>` and `--browser-instance <id>`; otherwise the
route is prepared and the command explains how to retrieve its URL. Existing
preview tabs in the same thread are reused. The thread must be focused for BB to
reveal its tab. Regular command output omits the token; only `--url` returns it.
Treat that URL as a private invitation, not a public link to publish.

`bb boat share --port 5173` shares any running development server. Omit the port
for Pitchfork discovery, or choose a daemon with `--daemon web`. Pass an explicit
startup command to start an app when needed:

```sh
bb boat share --command 'npm run dev -- --host 0.0.0.0' --port 5173
```

The command runs in a BB thread terminal with inspectable logs. Sharing never
rewrites project configuration or stops its daemons. The app must bind
`0.0.0.0` and allow its Boat hostname. Plain output withholds the token;
`bb boat share --url` returns only the private URL, and `--json` returns the
full result including the tokenized URL and browser target.

On create and resume, Boat preparation sets Ubuntu's
`kernel.apparmor_restrict_unprivileged_userns=0` before the template hook, so
agents can use bubblewrap inside the Boat sandbox. It writes
`/etc/sysctl.d/99-bb-boat-userns.conf` and reapplies it after snapshot restore.
This requires root or non-interactive sudo; failure blocks preparation with an
explicit diagnostic. Kernels without this sysctl are unchanged. Boat remains
the outer isolation boundary, and inner agent sandboxing stays enabled.

The plugin stores only route metadata, never signed URLs. Its minute maintenance
sweep hides plugin-created routes once their TCP port stops listening. Pre-existing
routes are preserved, including on `preview-stop`. Unreachable machines are retried
when they reconnect. Disabling the plugin stops automatic cleanup; remove an
orphaned route with `boat exec <sandbox> 'host hide <port>'`. A preview belongs to a
machine and port: threads on the same machine and port share the same application.

### Development settings per project

Set global defaults in Settings → Plugins → Boat Sandboxes:
`developmentCommand`, `developmentPort`, and `developmentDaemon`.
`projectDevelopment` stores overrides keyed by BB project ID in the same plugin
settings; no repository configuration file is required. For example:

```sh
bb plugin config boat-sandbox set projectDevelopment '{"proj_example":{"command":"npm run dev -- --host 0.0.0.0","port":5173}}'
```

This replaces the overrides object; preserve other project entries when editing.
CLI flags override project settings, which override global defaults. Omitted
project fields inherit; command `""` disables automatic startup by `share`, and
port `0` selects Pitchfork discovery. `share` starts a missing app only when a
command is configured or passed explicitly. `preview` never starts an app;
`dev` uses the configured command, falling back to `mise run dev`.
Settings are local to this BB installation and are not shared through Git.
