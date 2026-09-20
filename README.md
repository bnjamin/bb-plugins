# bb-plugins

Plugins for [BB](https://github.com/get-bb/bb), one per subfolder.

| Plugin | Purpose |
| --- | --- |
| [bb-plugin-boat-sandbox](bb-plugin-boat-sandbox/) | Run BB project threads on [Boat.dev](https://boat.dev) sandboxes: machine provider, snapshot-backed sleep/wake, app previews, and launch timing. |

## Install a plugin

```sh
cd <plugin>
npm ci
npm run typecheck
npm test
bb plugin build
bb plugin install .
```

Each plugin's README covers its configuration and validation notes.
