// Test-only: the worker child turns its event loop before its entrypoint listens, so the bootstrap and a directive sent right behind it
// are already buffered together on the IPC channel when the child first reads it (#53). Node then emits both in one tick batch.
await new Promise(resolve => setTimeout(resolve, 200));
