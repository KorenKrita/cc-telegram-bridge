# Codex Telegram Channel

Turn Codex into a Telegram-native coding operator.

`codex-telegram-channel` is a Windows-first bridge that binds one Telegram bot to one isolated Codex instance. Each instance keeps its own token, pairing state, access policy, inbox, update watermark, and Codex thread bindings.

## What It Does

- Runs one Telegram bot per instance
- Supports `pairing` and `allowlist` access control
- Stores per-chat Codex thread bindings and resumes them on later messages
- Sends a `Working...` placeholder, then edits it into the final answer
- Downloads incoming documents and photos into the instance inbox
- Serializes work per chat to avoid overlapping Codex runs
- Protects against duplicate local instance startup with an instance lock
- Includes CLI commands for configure, access control, service lifecycle, and status

## Repository Layout

- [src](C:/Users/hangw/codex-telegram-channel/src) contains the bridge, state, runtime, Telegram, and Codex integration code
- [tests](C:/Users/hangw/codex-telegram-channel/tests) contains the Vitest suites
- [site](C:/Users/hangw/codex-telegram-channel/site) contains the static landing page

## State Model

Per instance, state is stored under:

```text
%USERPROFILE%\.codex\channels\telegram\<instance>\
```

That directory contains:

- `.env`
- `access.json`
- `session.json`
- `runtime-state.json`
- `instance.lock.json`
- `service.stdout.log`
- `service.stderr.log`
- `inbox\`

## Quick Start

Install and build:

```powershell
cd C:\Users\hangw\codex-telegram-channel
npm install
npm run build
```

Configure a bot:

```powershell
npm run dev -- telegram configure <bot-token>
```

Configure a named instance:

```powershell
npm run dev -- telegram configure --instance work <bot-token>
```

Start the default instance:

```powershell
npm run dev -- telegram service start
```

Start a named instance:

```powershell
npm run dev -- telegram service start --instance work
```

Check status:

```powershell
npm run dev -- telegram service status
npm run dev -- telegram status
```

Stop an instance:

```powershell
npm run dev -- telegram service stop
```

## Access Control

Redeem a pairing code:

```powershell
npm run dev -- telegram access pair <code>
```

Set policy:

```powershell
npm run dev -- telegram access policy allowlist
```

Allow or revoke a chat:

```powershell
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
```

## Scripts

- `npm run build`
- `npm run dev`
- `npm start`
- `npm test`
- `npm run test:watch`

## Landing Page

Open the static page at:

- [site/index.html](C:/Users/hangw/codex-telegram-channel/site/index.html)

You can preview it locally with any static server. For example:

```powershell
cd C:\Users\hangw\codex-telegram-channel\site
python -m http.server 4173
```
