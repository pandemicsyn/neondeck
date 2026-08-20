# @neondeck/flue-sandbox-tensorlake

Use an existing [Tensorlake sandbox](https://docs.tensorlake.ai/sandboxes/sdk-reference) as a [Flue](https://flueframework.com/) sandbox.

This is a provider adapter, not a sandbox lifecycle manager. Your application creates or connects to the Tensorlake sandbox, wraps it for Flue, and later decides whether to suspend or terminate it.

## Install

```sh
npm install @neondeck/flue-sandbox-tensorlake @flue/runtime tensorlake
```

The package supports Node.js 22.19 or later, Flue Runtime 2.0.3 or later within the 2.x release line, and Tensorlake SDK 0.5.107 or later within the 0.5 release line. Tensorlake authentication uses the standard `TENSORLAKE_API_KEY` environment variable.

Choose a Tensorlake image with `bash` and GNU filesystem utilities (`stat`, `mkdir`, and `rm`). The adapter uses those utilities for filesystem operations that the SDK does not expose directly.

## Use

```ts
import { Sandbox as TensorlakeSandbox } from 'tensorlake';
import { tensorlake } from '@neondeck/flue-sandbox-tensorlake';

const remote = await TensorlakeSandbox.create({
  name: 'flue-session',
  timeoutSecs: 1_800,
});

const sandboxFactory = tensorlake(remote, { cwd: '/workspace' });

// Pass `sandboxFactory` to the Flue agent or runtime configuration that needs it.
// The application, not this adapter, owns remote.suspend() / remote.terminate().
```

`tensorlake(remote)` creates a `SandboxFactory`. Each Flue-created sandbox uses the supplied remote handle and defaults its working directory to `/workspace`; pass `cwd` to choose another directory.

## Adapter behavior

- Commands run through `bash -lc`, so Flue shell strings retain pipes, redirects, and expansions. Per-command `cwd`, `env`, and timeouts are forwarded to Tensorlake. Flue timeouts are milliseconds; Tensorlake timeouts are rounded up to seconds.
- Text and binary reads/writes plus directory listings use Tensorlake's native file APIs.
- `stat`, `exists`, `mkdir`, and `rm` execute the standard sandbox utilities using argument vectors. Paths are never interpolated into shell text.
- Tensorlake's foreground `run()` API does not accept an `AbortSignal`, so cancelling a Flue caller cannot guarantee that the remote command stops. Use a timeout or an application-owned process handle when cancellation of remote work is required.
