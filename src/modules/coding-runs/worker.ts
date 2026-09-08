// Public detached-worker artifact primitives. No store, adapters, host admission, or agent runtime.
export {
  artifactHash,
  atomicWrite,
  privateDirectory,
  readBytesBounded,
  readSigned,
  writeSigned,
} from './host-io';
export type { LocalAttemptHandle } from './host-contract';
