// Test-only, loaded after provider-preload: the scripted provider's response is held until this child has received the Host's abort
// (#53). A late abort then deterministically lands while the native session runs, never after it finished. Listening here does not
// consume a message: the entrypoint's own listener still receives the bootstrap and the abort.
const scripted = globalThis.fetch;
const aborted = new Promise<void>(resolve => {
  process.on('message', message => {
    if ((message as { kind?: unknown }).kind === 'abort') resolve();
  });
});
globalThis.fetch = async (...request: Parameters<typeof fetch>) => {
  const response = await scripted(...request);
  await aborted;
  return response;
};
