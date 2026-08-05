---
'neondeck': patch
---

Bind the Flue development server to the same IPv4 loopback address used by the dashboard proxy, and isolate the web server's Vite dependency cache so the two development servers cannot invalidate each other's optimized modules.
