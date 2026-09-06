import { openSync, writeSync, closeSync, fsyncSync, constants } from 'node:fs';
import { join } from 'node:path';
import { CodexEvents } from './codex-adapter.ts';
import type { LocalManifest } from './host-contract.ts';

export class HostOutput {
  readonly events = new CodexEvents();
  bytes = 0;
  failure: string | null = null;
  private buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  private files: { stdout: number; stderr: number };
  private written = 0;
  private manifest: LocalManifest;
  private redact: (text: string) => string;
  constructor(manifest: LocalManifest, redact: (text: string) => string) {
    this.manifest = manifest;
    this.redact = redact;
    this.files = {
      stdout: openSync(
        join(manifest.directory, 'stdout.jsonl'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      ),
      stderr: openSync(
        join(manifest.directory, 'stderr.log'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      ),
    };
  }
  private flush(stream: 'stdout' | 'stderr', newline: boolean) {
    // Incomplete lines are discarded: never persist a truncated credential prefix.
    if (!newline) {
      this.buffers[stream] = Buffer.alloc(0);
      return;
    }
    const redacted = Buffer.from(
      this.redact(this.buffers[stream].toString('utf8')) +
        (newline ? '\n' : ''),
    );
    const bounded = redacted.subarray(
      0,
      Math.min(
        this.manifest.config.maxLineBytes + 1,
        this.manifest.config.maxOutputBytes - this.written,
      ),
    );
    writeSync(this.files[stream], bounded);
    this.written += bounded.length;
    this.buffers[stream] = Buffer.alloc(0);
  }
  accept(stream: 'stdout' | 'stderr', data: Buffer) {
    if (this.failure) return;
    const available = this.manifest.config.maxOutputBytes - this.bytes;
    const bounded = data.subarray(0, available);
    this.bytes += bounded.length;
    let offset = 0;
    while (offset < bounded.length) {
      const end = bounded.indexOf(10, offset);
      const stop = end < 0 ? bounded.length : end;
      const room =
        this.manifest.config.maxLineBytes - this.buffers[stream].length;
      const piece = bounded.subarray(offset, Math.min(stop, offset + room));
      this.buffers[stream] = Buffer.concat([this.buffers[stream], piece]);
      if (piece.length < stop - offset) {
        this.failure = 'line-limit';
        this.flush(stream, false);
        return;
      }
      if (end < 0) break;
      if (stream === 'stdout') {
        try {
          this.events.accept(this.buffers[stream].toString('utf8'));
        } catch {
          this.failure = 'malformed-provider-output';
        }
      }
      this.flush(stream, true);
      if (this.failure) return;
      offset = end + 1;
    }
    if (data.length > available) this.failure = 'output-limit';
  }
  finish() {
    if (this.buffers.stdout.length && !this.failure)
      this.failure = 'truncated-provider-output';
    this.flush('stdout', false);
    this.flush('stderr', false);
    try {
      fsyncSync(this.files.stdout);
      fsyncSync(this.files.stderr);
    } finally {
      try {
        closeSync(this.files.stdout);
      } finally {
        closeSync(this.files.stderr);
      }
    }
  }
}
