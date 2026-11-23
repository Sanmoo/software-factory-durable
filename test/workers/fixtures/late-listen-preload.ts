// Test-only: the worker entrypoint listens only after the parent ends this child's stdin, which the parent does once the bootstrap and a
// directive sent right behind it are both flushed to the IPC channel (#53). The child then reads them together and Node emits both in one
// tick batch. An event, not a wait: the parent's send callbacks, then stdin's end.
for await (const _ of process.stdin);
