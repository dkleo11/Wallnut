# Wallnut

[简体中文](README.md) · **English**

![version](https://img.shields.io/badge/version-0.5.0-0A84FF) ![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-34C759) ![core](https://img.shields.io/badge/core-mihomo-5E5CE6)

---

**Wallnut** is a desktop proxy client for Windows: an Electron shell with a bundled [mihomo](https://github.com/MetaCubeX/mihomo) core. Portable, no installation required.

**Name**: "Wallnut" reads as *wall-nut*, a pun on **wall-not** — and a nod to the **wall-nut** in *Plants vs. Zombies*.

## Features

- **Subscriptions**: add, edit (name / URL / refresh interval), refresh and remove; Clash/mihomo YAML, Surge conf, share links, base64 and paste import
- **Nodes & regions**: nodes grouped by country, cross-subscription speed tests to find the fastest one, per-node tests and latency sorting
- **Policy groups**: region groups plus custom groups with select / url-test / fallback, switchable straight from the card
- **Routing**: local rule list with ordering and validation, remote rule sets with automatic updates
- **Rewrite**: local rewrite rules, remote rewrite rule sets, 302 redirects, request/response headers, response body replacement, whitelist-based MITM
- **Core supervision**: single-instance management, health checks, crash restart, config validation, ring-buffered logs
- **Network takeover**: system proxy, TUN mode, DNS and fake-ip, DNS cache flush
- **Live dashboards**: traffic charts, active connections, rule hits, core memory and version
- **Desktop**: tray menu, launch at login, light / dark / system theme, close-to-tray
- **Languages**: English, 简体中文, 繁體中文, 日本語, 한국어, Français, Español

## Download

Grab `Wallnut-v0.5.0-portable-win-x64.zip` from **Releases**:

1. Download `Wallnut-v0.5.0-portable-win-x64.zip`
2. Unzip anywhere (no install needed)
3. Run `Wallnut.exe`
4. Add your own subscription in the app

On first launch the app creates `data/` and `temp/` next to the executable; config, state, logs and certificates stay on this machine.

## Run from source

Requirements: Windows 10/11, Node.js 18+.

```bash
git clone https://github.com/dkleo11/Wallnut.git
cd Wallnut
npm install
npm install --no-save electron
```

The repository does **not** ship binaries. Supply the following files under `resources/`:

| Path | Purpose | Source |
| --- | --- | --- |
| `resources/core/mihomo.exe` | mihomo core | [MetaCubeX/mihomo Releases](https://github.com/MetaCubeX/mihomo/releases) `windows-amd64` |
| `resources/geo/geoip.metadb`, `geosite.dat`, `country.mmdb` | Routing data | [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) |

Environment overrides:

| Variable | Effect |
| --- | --- |
| `WALLNUT_CORE` | Path to the mihomo executable |
| `WALLNUT_DATA` | Data directory |
| `WALLNUT_PORTABLE=1` | Force portable mode |

Run:

```bash
npx electron .
```

## Project layout

```
electron/           main process (main / ipc / store / tray / autostart)
  config/           mihomo config generation
  core/             core supervision: process, REST API, speed tests
  net/              system proxy
  rewrite/          rewrite and MITM certificates
  subs/             subscription download and parsing
renderer/           renderer (plain DOM + Preact/htm, no build step)
  pages/            page views
  vendor/           vendored front-end deps
resources/          icons only (core and geo data are not committed)
locales.json        UI strings (7 languages)
package.json
```

## Changelog

### 0.5.0 — 2026-11-23

**Added**

- Bottom-left connection status now shows "subscription / node": policy groups are followed down to the real node, then mapped to its subscription, rendered on two lines
- DNS group in Settings is expanded by default (still collapsible via its heading)

**Improved**

- "Launch at login" note simplified to "Starts automatically after boot"; the portable-only wording is gone

**Fixed**

- TUN adapter now uses its own name `Wallnut` instead of sharing `Meta` with the Clash Verge service (which had got the core terminated externally and restart attempts timing out)
- Headless verification mode no longer starts the core, rewrite or system proxy, so test instances stop stealing ports, the TUN adapter and the system proxy registry from the running instance

**Removed**

- Portable-specific wording in the "Launch at login" setting

### 0.4.8 — 2026-11-23

**Added**

- Editable subscriptions: name, URL, refresh interval, skip-certificate and enabled state; changing the URL re-downloads and rebuilds nodes and groups
- Seven UI languages: 简体中文, 繁體中文, 日本語, 한국어, English, Français, Español
- Region groups can switch between manual selection and url-test auto-selection
- Remote rewrite rule sets: http(s) links refreshed on an interval and merged with local rules (local wins)
- Connection source shown as "subscription / node" in the bottom-left status

**Improved**

- Frosted-glass styling for the custom policy group dialog and the language dropdown
- Logs page cards fill the content area with filters and actions kept intact
- Light mode brightened overall
- Subscription cards show format, node count, last update, interval and last error

**Fixed**

- Light mode primary buttons rendered white-on-white after being overridden by the generic button style
- Manually selecting a node in a region group prevented switching back to auto
- Home "memory usage" metric always waited for core data; removed

**Removed**

- Home memory usage card
- Settings notification test button
- Per-node edit entry inside node rows (editing moved to subscription level)

### 0.4.0 — 2026-11-22

- First source release: portable Windows client with Electron and a bundled mihomo core
- Subscriptions, region aggregation, policy groups, routing, rewrite and MITM, system proxy and TUN, tray and autostart
- Project renamed to **Wallnut**, repository moved to `dkleo11/Wallnut`

### 0.3.0 — 2026-11-21

- Project renamed to Wallnut across UI, tray and notifications
- Policy group panel trimmed to 3 node entries by default
- Nodes page merged into "Subscriptions & local nodes"

## Notice

Please follow the laws and regulations of your region and use this project only for lawful network access.
