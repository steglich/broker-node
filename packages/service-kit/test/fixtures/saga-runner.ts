// Processo que inicia uma saga de saque e morre (SIGKILL) no meio da transferência.
import { uuidv7 } from '@broker/ids';
import { createDatabase } from '@broker/persistence';
import { SagaOrchestrator } from '../../src/index.js';
import { withdrawalSaga } from './sagas.js';

const db = createDatabase(JSON.parse(process.env['SAGA_DB']!));
const orchestrator = new SagaOrchestrator({
  db,
  newId: uuidv7,
  definitions: [
    withdrawalSaga(db, {
      inTransfer: async () => {
        console.log('IN_TRANSFER');
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => undefined);
      },
    }),
  ],
});
await orchestrator.start('withdrawal', {
  withdrawalId: process.env['WITHDRAWAL_ID']!,
  amount: '150.00',
});
