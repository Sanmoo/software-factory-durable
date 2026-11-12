import { createRecords } from '../../src/records/index.js';

const root = process.argv[2]!;
const id = process.argv[3]!;
const records = await createRecords({ root });
try {
  await records.read({ reference: { workId: 'work-05', id }, offset: 0, limit: 1 });
  process.exitCode = 1;
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'PROTECTED_CAPTURE_UNAVAILABLE') throw error;
}
