import { cli, withTeardown, type PhaseState } from './context11-qualification.js';

// Child-process fixture of the ticket 11 recipe CLI driver with REAL process hooks (exit, uncaughtException/unhandledRejection). The phase
// body is scripted by CONTEXT11_EXIT_MODE; nothing touches GitHub, a VM, a model or $HOME. Prints one line per recorded late error.
const mode = process.env.CONTEXT11_EXIT_MODE;
const saved = (state: PhaseState | null) => {
  state!.resultSaved = true;
};
await cli(process.argv.slice(2), {
  async run(_args, state) {
    if (mode === 'saved-then-failing-teardown') {
      // The inspect result is complete, then closing the storage copy / releasing the lock fails.
      await withTeardown(
        state!,
        async () => {
          saved(state);
        },
        async () => {
          throw new Error('STORAGE_COPY_CLOSE_FAILED');
        },
      );
      return;
    }
    if (mode === 'saved-then-late-rejection') {
      saved(state);
      void Promise.reject(new Error('LATE_SESSION_REJECTION'));
      await new Promise(resolve => setTimeout(resolve, 50));
      return;
    }
    if (mode === 'error-before-save') throw new Error('PHASE_FAILED');
    if (mode === 'late-rejection-before-save') {
      void Promise.reject(new Error('EARLY_REJECTION'));
      await new Promise(resolve => setTimeout(resolve, 2000));
      saved(state);
    }
  },
  exit: code => process.exit(code),
  on: (event, listener) => {
    process.on(event, listener);
  },
  error: text => process.stderr.write(`${text}\n`),
  recordLate: (state, code) => process.stdout.write(`${JSON.stringify({ late: code, phase: state.phase })}\n`),
});
