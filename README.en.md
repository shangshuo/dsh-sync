# DSH Sync · DSH Config Sync Plugin

[English](./README.en.md) · [简体中文](./README.md)

Encrypts a whole machine's DSH "personal state" and backs it up to the cloud, so switching computers is a one-command restore: plugins, plugin settings, model & UI preferences, MCP servers, self-built skills, API keys — all inside.

- **One archive**: every piece of config is packed into a single encrypted file; the cloud only ever sees ciphertext.
- **Three targets**: S3-compatible object storage, WebDAV, or a local sync folder (iCloud/OneDrive/Nutstore/NAS).
- **Selectable contents**: the backup is split into 11 modules, each toggleable in the Settings page with live sizes; privacy modules (MCP connector, API keys) are off by default and require acknowledging a privacy notice.
- **Scheduled sync**: automatic backups at minute-level intervals; unchanged content is never uploaded.
- **Rollback-friendly**: files being overwritten are backed up before a restore; files that exist only on this machine are never deleted.
- **English & Chinese UI**: follows the DSH language setting automatically (switching takes effect instantly, no restart); untranslated strings fall back to Chinese.

---

## 1. What it syncs (0.4 modular layout)

The backup is split into modules, toggleable under Settings → Sync → Back up → What to back up (with live file counts / sizes):

| Module | Archive prefix | Local source | Default | Contents |
| --- | --- | --- | --- | --- |
| DSH profile | `profile/` | `profiles/<profile>/` whitelist | **Required** | `package.json` (plugin manifest), `cordis.patch.yml` (**all plugin settings, MCP servers, model/UI preferences**), `cordis.yml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.dsh-market/state.json` |
| Local-folder plugins | `local-plugins/` | Source folders of `link:`/`file:` dependencies | On | Source of non-marketplace plugins (without their node_modules). Unpacked and re-linked automatically on restore — **no manual reinstall**; makes backups larger |
| Machine-level patch | `home/` | `$DSH_HOME/cordis.patch.yml` | On | User-level patch |
| DSH home skills | `skills-dsh/` | `$DSH_HOME/skills/` | On | Self-built skills (skipped automatically when absent) |
| Cross-tool skills | `skills-agents/` | `~/.agents/skills/` | On | Skills shared with other agent tools |
| Desktop UI preferences | `ui/` | `$DSH_HOME/.dshw-size.json` | On | Window zoom, sound effects, bubble toggles, etc. |
| Skill manager settings | `skill-manager/` | `skills-manager/state.json`, `dsh-skill-explorer/provider-toggles.json` | On | Skill source toggles and disabled list |
| MCP connector | `mcp/` | `storages/mcp_connector.json` | **Off** ⚠️ | Desktop MCP connections and grants, **may contain access tokens** (privacy notice below) |
| Workspace root dependencies | `workspace-root/` | `profiles/package.json` | Off | The workspace root's `dshmarket` dependency; DSH can usually rebuild it |
| Credentials & API keys | `credentials/` | `.credentials.yaml` + `.env` | **Off** ⚠️ | API keys / account tokens (device-bound records are never uploaded) |
| Plugin code | `node-modules/` | The profile's `node_modules/` | Off | Offline restorable but large; by default plugins are reinstalled via `pnpm install` on restore |
| Extra folders | `extra-N/` | `include.extraPaths` | Empty | Any custom folders |

**Privacy notice** (shown in full when a ⚠️ module is enabled): these files may contain API keys or server access tokens. Such content is **never uploaded to any third party** — files are read locally, encrypted as a whole (scrypt-derived key), and only ciphertext ever leaves the device; neither the plugin author nor the cloud storage can decrypt it. Credential files have device-bound records stripped locally before being packed (stripping never leaves this machine). The plugin itself has no telemetry and reports nothing.

**Profile whitelist**: the DSH profile module packs only the 6 files listed above — plugin-manager logs (`.plugin-manager/`), marketplace logs (`.dsh-market/log.ndjson`), `package.json.lock` and other runtime artifacts **no longer enter the archive**. If DSH ever adds new config files at the profile root, `PROFILE_FILES` in `lib/collect.js` needs updating accordingly.

**Not synced**: session history (`sessions/`), workspace caches (`storages/session_projcache` etc.), account usage stats (`.dshw-usage.json`), device identifiers (`.anonymous-user-id`), model catalog caches (`.workbuddy-*`, `dsh-moa-catalog.json`).

---

## 2. Choosing a storage target

| Option | Best for | Setup | Notes |
| --- | --- | --- | --- |
| **Cloudflare R2** | International/global | ★ | S3-compatible, 10 GB free, no egress fees; mediocre access from mainland China |
| **Backblaze B2** | International/global | ★ | S3-compatible, 10 GB free, cheap |
| **AWS S3 / Wasabi / iDrive e2 / Scaleway / Hetzner / MinIO** | Various regions | ★ | All go through the same S3 adapter; just fill in endpoint/region/bucket/AK/SK |
| **Alibaba OSS / Tencent COS** | Mainland China | ★★ | S3-compatible subset with AK/SK; bucket names often carry an APPID (COS) |
| **Nutstore (Jianguoyun) WebDAV** | Mainland China individuals | ★ | `https://dav.jianguoyun.com/dav/` + app password; the free quota is small but plenty for configs |
| **Nextcloud / Seafile / Synology / pCloud / Yandex Disk / Koofr / kDrive** | Self-hosted or international | ★ | All provide WebDAV with app passwords |
| **Local sync folder** | Everyone | ★ | Point at iCloud Drive / OneDrive / Nutstore sync folder / a NAS mount — zero keys |
| **rclone / OpenList bridge** | Baidu Netdisk, Google Drive, OneDrive, Dropbox, MEGA… | ★★★ | Run `rclone serve webdav` or OpenList locally; this plugin treats it as plain WebDAV. See `cloud-backup-comparison.md` |

**Recommended**: mainland China = Nutstore WebDAV (easiest) or Alibaba OSS (most reliable); international = Cloudflare R2; no sign-ups at all = local sync folder.

A fuller comparison of 15 object stores and 20+ drive APIs (pricing, regions, OAuth requirements) lives in [`cloud-backup-comparison.md`](./cloud-backup-comparison.md).

> Baidu Netdisk / Alibaba Cloud Drive / Quark Drive have no usable general API (OAuth + developer review, third-party clients restricted) and are not built in; bridging via OpenList → WebDAV is the realistic path.

---

## 3. Installation

The plugin folder is this repository (`package.json` declares `dsh.bundle.patch`).

**Option A: graphical UI**
Settings → Plugins → Install local plugin → pick this folder.

**Option B: let the Agent do it**
Tell the agent "install the directory `C:\...\dsh-sync` as a plugin"; it will call `plugin_manager`'s `install_bundle`.

After installation the Host-side tools take effect immediately; the Settings page is a front-end module and **needs one DSH restart** (quit fully, then reopen) to appear.

---

## 4. Usage

### Graphical UI: Settings → Sync

After restarting, open Settings and a **Sync** section appears on the left. Since 0.4 the page opens with a **persistent status bar** (synced / changes pending / incomplete + last-backup summary) above three tabs:

- **Back up**: the backup module list (per-module toggles, live sizes) → storage target → passphrase → schedule → actions. Every action's result renders right below its buttons; long operations show stage hints.
- **Restore / Import**: the cloud snapshot list (loaded automatically) → preview (expandable full list, shows which plugin packages will be auto-installed) → inline two-step confirmation → restore result and restart hint. You can also import from a `.dshsync` file/folder.
- **Advanced**: named profile management (create/rename/delete), status details, data & log paths.

Everyday use needs no command line or chat:

1. On the **Back up** tab pick the target type (S3-compatible / WebDAV / local folder) and fill in address and keys. Saved keys show as `••••••••`; click Change to replace them.
2. Set the passphrase: the rules are checked live as you type (≥8 chars, upper + lower case, digit, symbols limited to `@ # $ * - _`).
3. In **What to back up** tick the modules to sync (privacy modules require acknowledging the privacy notice).
4. Optionally enable scheduled backups and set the interval.
5. Click **Test connection** → **Back up now**. Snapshot names look like `prefix/snapshots/<machine>_<UTC time>_<random>.dshsync`, so multiple machines on one target stay distinguishable.
6. **Restore**: switch to the Restore / Import tab → the snapshot list loads automatically → pick one (shows "device · time · size"; the newest is marked) → **Preview selected snapshot** → **Restore to this machine** (double confirmation) → restart DSH.

Local-folder mode needs no separate "import" button: copy the other machine's `latest.json` and `snapshots` folder into the target directory (`…\<prefix>\`) and the snapshot list picks them up automatically. Even without `latest.json`, any `.dshsync` file inside `snapshots` can be listed and restored.

If you have an archive or loose files: unzip, then in "Import from file" click **Choose file…** (or **Choose folder…**) to pick the `.dshsync` file/folder, and click **Preview this file**; pasting a path also works.

### Chat & tools

Once installed, the Agent gains 7 tools:

| Tool | Purpose |
| --- | --- |
| `sync_status` | Show the active profile, target, pending changes, latest remote snapshot, schedule, errors |
| `sync_configure` | Write the active profile (target, passphrase, include scope, schedule, limits) |
| `sync_profile` | Manage named profiles: list / create / select / rename / delete |
| `sync_test` | Connectivity check: write a probe object → read it back → delete it |
| `sync_push` | Back up now (skipped when nothing changed) |
| `sync_pull` | Restore: preview-only by default; `dryRun:false` + `confirm:true` writes to disk |
| `sync_snapshots` | List cloud snapshots |

The `include` module keys (0.4): `profile` (always on), `homePatch`, `skillsDsh`, `skillsAgents`, `uiPrefs`, `skillManager`, `mcpConnector`, `workspaceRoot`, `credentials`, `nodeModules`, `extraPaths`. The legacy 0.3 keys `skills`/`agentsSkills` migrate automatically.

### Typical conversations

> "Back up my DSH config to my Cloudflare R2 — bucket `dsh-config`, AK/SK are …, passphrase is …, auto-sync every 30 minutes."

The agent calls `sync_configure` → `sync_test` → `sync_push` in order.

> "Create another profile called 'Office cloud' and switch to it."

The agent calls `sync_profile` (create/select); afterwards `sync_configure` writes to "Office cloud".

On a new machine:

> "Restore my DSH config from R2 — show me which files would change first."

After you confirm, the agent runs `sync_pull` (`confirm: true`) and prompts you to restart DSH.

### Config storage & encryption

`$DSH_HOME/dsh-sync/config.json` **is entirely ciphertext** — just an envelope:

```json
{ "format": "dsh-sync-config", "version": 2, "cipher": "sm1", "blob": "…" }
```

Key sources, in priority order:

| cipher | Key | Notes |
| --- | --- | --- |
| `sm1` | OS keychain (Windows DPAPI / macOS Keychain) | Default. Copying the file away or switching OS users makes decryption impossible |
| `ev1` | Derived from env var `DSH_SYNC_MASTER_KEY` | Servers / headless environments |
| `ag1` | Sibling `secret.key` file (0600) | Last resort; only deters casual reading |

Not even the bucket, endpoint or AK is visible in the file; the page's "Encryption" row shows which one is active. For extra safety you can set `passphrase` to `env:DSH_SYNC_PASSPHRASE` and keys to `env:NAME` in `sync_configure` — then even the in-memory config never hits disk in plaintext.

Legacy (v1) plaintext configs migrate to the encrypted v2 format on first load.

### Scheduled sync

With `schedule.enabled = true`, the Host checks every minute whether the active profile is due (default 30 minutes); identical content hashes produce no new snapshot, and failures retry on the interval.

---

## 5. Security model

- Archive = `gzip` → **AES-256-CTR** → **HMAC-SHA256** (encrypt-then-MAC), keys derived from your passphrase with **scrypt** (N=32768, r=8, p=1), independent salt/iv per archive.
- Downloads verify the HMAC before any decryption; a wrong passphrase or tampered file fails loudly.
- The cloud only ever sees `latest.json` (time, size, content hash) and ciphertext snapshots; filenames contain nothing but timestamps.
- The local config is stored fully encrypted (`safeStorage` → DPAPI/Keychain; falls back to AES-256-GCM + `secret.key`), state files are `0600`; **device-bound records in `.credentials.yaml` (browser session, device ID) are never uploaded**, and a restore never overwrites the local copies of those two records.
- Passphrase rules: ≥8 characters with upper case, lower case, a digit and at least one of `@ # $ * - _`; no other characters allowed. The page names exactly what's missing and calls out disallowed characters (spaces, full-width glyphs, etc.).
- Advice: use a 12+ character passphrase you don't reuse elsewhere; type it on the page or reference it via `env:`.

---

## 6. Restore semantics & rollback

1. `sync_pull` defaults to `dryRun`, returning only the list of files that would be added/overwritten.
2. Writes happen only with `dryRun:false` **and** `confirm:true`; overwritten files are copied to `$DSH_HOME/dsh-sync/backups/<timestamp>/` first.
3. Files that exist only locally are **never deleted**; sources missing from the snapshot (e.g. `extraPaths` not configured here) are skipped with a warning.
4. Changes under `profile/` return `restartRequired: true` — restart DSH to apply.
5. Missing plugin packages: with `restore.installBundles` true (default), DSH's own pnpm runs `pnpm install` in the profile; failures warn and keep the backups. Local-folder plugins (`link:` / `file:`) are unpacked from the snapshot's source copy and re-linked automatically (0.5+); if a same-named local link still works here, the local version is kept.

---

## 7. Known limitations (0.6)

- Session history is not backed up; concurrent changes from two machines are not merged (last write wins — roll back from backups).
- `node_modules` is not synced by default: registry plugins and local-folder plugins are reinstalled/re-linked via automatic `pnpm install` on restore (local plugin sources are inside the snapshot).
- The profile is backed up as a 6-file whitelist: when DSH adds new config files at the profile root, `PROFILE_FILES` in `lib/collect.js` needs updating (the restore side only warns on unknown files — no data loss).
- Archives are processed fully in memory with a default 256 MB cap (`limits.maxArchiveMB`); raise it before enabling `nodeModules` and mind the memory.
- The config is stored fully encrypted (`safeStorage` / DPAPI, falling back to AES-256-GCM + a local key file); but malicious software running as the same OS user can still call the OS decryption APIs — that's an OS constraint no plugin can bypass.
- The Settings page has no automated tests (kept zero-build, zero-dependency); UI regressions rely on the manual checklist in `TESTING-2-MACHINES.md`.

---

## 8. Development & testing

Pure ESM with zero third-party dependencies — only `node:*` imports (`electron` is an optional dynamic import); the plugin runs inside the Host process.

```powershell
node --test test/           # or run files individually, see below
node test/core.test.js      # archive / crypto / SigV4 / credential filtering
node test/backends.test.js  # S3 and WebDAV against a local HTTP server
node test/engine.test.js    # push / status / prune / pull / module whitelist / rollback
node test/config.test.js    # encrypted config, v1 migration, named profiles, include key migration
node test/api.test.js       # form view, passphrase rules
node test/api-handler.test.js # settings-page HTTP API (incl. modules.preview)
node test/i18n.test.js      # message localization
node test/plugin.test.js    # 7 tools against a fake Cordis context
node scripts/live-verify.mjs  # live-machine verification (reads real ~/.dsh, writes to a temp dir)
```

Layout:

```
index.js              Plugin entry (apply, scheduler, pnpm invocation)
client.js             Settings page (status bar + Back up / Restore / Advanced tabs)
lib/container.js      Archive container + authenticated encryption
lib/collect.js        Snapshot collection (module list, profile whitelist, stat-only preview)
lib/engine.js         push / pull / status / prune
lib/config.js         Config, state, logs, secret masking
lib/i18n.js           Host-side message localization (Chinese source text as key)
lib/tools.js          7 agent tools
lib/backends/         s3.js / webdav.js / local.js
lib/credentials.js    Device-bound record filtering & merging
scripts/live-verify.mjs  Live round-trip & legacy snapshot compatibility checks
test/                 node:test cases
```
