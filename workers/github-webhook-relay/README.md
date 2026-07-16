# GitHub webhook relay

An independently deployed Cloudflare Worker for relaying signed GitHub webhook
deliveries to authenticated WebSocket clients.

This package is intentionally isolated from the Neondeck runtime. Run its
commands from this directory.

```sh
fnm exec --using=26.4.0 npm install
fnm exec --using=26.4.0 npm run check
fnm exec --using=26.4.0 npm run dev
```
