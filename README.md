# dsh-provider-toggle

**English** | [中文](README.zh.md)

![license](https://img.shields.io/badge/license-MIT-blue) ![DSH plugin](https://img.shields.io/badge/DSH-plugin-4c8bf5) ![version](https://img.shields.io/badge/version-1.0.0-brightgreen) ![runtime deps](https://img.shields.io/badge/runtime%20deps-none-success)

> **One-click enable/disable switch for every model provider in DeepSeek Harness**, sitting in **Settings → Models** right next to *Edit*.
> Turn a provider off and it leaves the composer's model picker; turn it back on and it returns.

![The switch to the left of Edit on every provider row](preview/placement-zoom.png)
*The switch lands to the left of the **Edit** button on each row (screenshot from the offline geometry harness — all 3 rows pass).*

```
Settings → Models
┌──────────────────────────────────────────────┐
│ opencode-go                       ●   ( ) Edit  Delete │  ← switch, left of Edit
│                                           ↑             │
└──────────────────────────────────────────────┘
```

---

## Install

One line from GitHub:

```sh
dsh plugin --profile desktop add github:DeepseekDays/dsh-provider-toggle
```

(use your own profile name instead of `desktop` if different).

From a checkout — same three steps, but **without running pnpm**:

```bash
node install.mjs              # install or repair
node install.mjs --dry        # show what would change
node install.mjs --uninstall  # uninstall (keeps the folder)
```

`install.mjs` does exactly three things (it never runs pnpm, so it will not rebuild
`node_modules` and cannot interrupt a live session): create a directory junction, add a
`link:` dependency to the profile's `package.json`, and append the package name to
`dsh.profile.bundles`. It writes a `.bak-provider-toggle-*` backup before touching the
manifest. The profile defaults to `~/.dsh/profiles/desktop`; set `DSH_PROFILE_DIR` to
target another one.

Then **fully quit DSH, tray included, and start it again** — bundle lists and the browser
module table are read at startup, so HMR will not pick up a new package.

## How it works

There is exactly one load-bearing fact: **DSH's model picker only renders provider groups
that have at least one model.**

`@deepseek-ai/dsh-api-session-controller`'s `buildModelCatalog()` contains

```js
groups.filter(group => group.models.length > 0)
```

So the plugin hooks in as lightly as possible — by wrapping `ctx.llm.listModels()`:

| Half | File | What it does |
|---|---|---|
| host | `index.js` | A disabled provider route makes `listModels()` return `[]` → the group is dropped → it disappears from the picker |
| client | `client.js` | Renders `@deepseek-ai/dsh-client-ui-primitives`' `<Switch>` into the `settings.models.provider-card` keyed slot; reads and writes through the existing `ctx.remote.settings` |

**It only affects the catalog and the picker, never routing.** `dsh-llm` says so itself:
*"Core routing accepts unlisted model ids; catalog-driven entry points such as the GUI may
require membership."* Sessions already using one of these models keep working; the model
simply stops being offered in the picker.

### Where the state lives

In the plugin's own settings namespace (`Config.disabled`, marked `.volatile()`):

- It goes through DSH's native settings service → persisted into the profile's
  **`cordis.patch.yml`** (the `id: dsh-provider-toggle` entry).
- The browser half uses `ctx.remote.settings.describe() / mutate()` directly — no custom
  remote endpoint.
- Editing any provider in Settings makes DSH rewrite the whole `cordis.patch.yml`, but it
  rewrites from in-memory state and our value is already in memory, so **it is not clobbered**.
- `.volatile()` makes changes **take effect hot**: the loader emits
  `loader/volatile-update`, the plugin broadcasts `llm/adapters-updated`, and the browser
  reloads the model catalog on the spot. **Toggling never needs a DSH restart.**

### Why every provider is one registration

`settings.models.provider-card` is a **keyed** slot: rendering matches a registration's
`key` against `renderSlot(name, props, { entryKey: row.entry.settingsNs })`. All of pi-ai's
routes (DeepSeek / openai / opencode-go / custom relays…) **share the same settingsNs** —
they differ only by `settingsPath: ["providers", <route>]`. So **one keyed registration
renders once per row**, with that row's `provider` in props. Namespaces of their own (such
as `deepseek-account`) get a second registration.

### How the position is decided

Slot content renders **below** rowHead by default (inside the same card). To sit left of
*Edit*, the component measures `li` / `[class*="rowHead"]` / `[class*="rowActions"]` with
`getBoundingClientRect()` after mount and absolutely positions itself there (class names are
CSS Module hashes, hence the `[class*=...]` substring selectors). **If it cannot measure, it
falls back to inline layout — the feature keeps working.**

## Verification

Three offline harnesses, none of which needs DSH running (each re-implements the contract
independently, then the results are compared):

```bash
node test-filter.mjs              # host logic: 16 assertions
node test-client.mjs              # client logic: 13 assertions
node preview/placement-check.mjs  # layout geometry + screenshot
```

- `test-filter.mjs` re-implements `buildModelCatalog()`'s group filtering and covers
  "off → gone / on → back / uninstall → restored / repeated apply does not stack / the
  fallback path when config is not a ref".
- `test-client.mjs` drives a minimal fake React to check the slot registration shape, the
  `Switch` state and the `mutate` arguments.
- `preview/placement-check.mjs` extracts the **real CSS** from a DSH installation (Settings
  row styles and the frontend Switch module), extracts the **real `placeSwitch()`** out of
  `client.js`, rebuilds the DOM React would produce, and measures geometry + screenshots
  through local Edge over CDP (`preview/placement.html` / `placement.png` /
  `placement-zoom.png`). Pass criteria: switch's right edge 6–11 px from *Edit*, vertical
  centre delta < 3 px, inside the card, no overlap with the button group. Needs `DSH_APP_DIR`
  (default `F:/DSH/DSH Desktop/resources/app`) and `EDGE_PATH`.

## Known limits

- **No switch for `deepseek-account`.** `@deepseek-ai/dsh-client-ui-settings-models` calls
  `remote.session.modelCatalog()` once while building the row list and then runs
  `rows.filter(row => row.entry.provider !== "deepseek-account" || row.accountAvailable === true)`
  — so once this provider is dropped from the catalog, **its own row disappears too** and
  there is no UI left to turn it back on (you would have to edit the profile's
  `cordis.patch.yml` by hand).
- **Do not disable the provider of the model you are currently using.** In the picker it
  becomes "unavailable"; requests still go through, but you will have switched models first.
  To recover: Settings → Models → flip the switch, or clear `config.disabled` in the
  `id: dsh-provider-toggle` entry of the profile's `cordis.patch.yml`.
- The switch only changes *what the picker offers*. It touches no provider config, key or
  model catalog — it is fully orthogonal to *Edit* / *Delete* and reversible at any time.
- Positioning is measurement-based, so if DSH ever changes the Settings row structure (no
  more `rowHead` / `rowActions` in the class names) the switch falls back to inline display:
  still functional, just no longer left of *Edit*.
- Third-party clients that fetch their own model catalog (e.g. a standalone panel from the
  marketplace) are unaffected.

## Relationship to other plugins

Coexists with `dsh-ofm-model-manager` (per-model enable/disable and renaming): both only
shape the model catalog, and their preference keys are independent. This plugin is an
ordinary bundle in the profile and **modifies no kernel file**.

## License

MIT
