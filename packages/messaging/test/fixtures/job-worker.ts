// Worker de jobs em processo separado: recebe o job, avisa e trava sem confirmar (ack),
// para o teste matá-lo no meio do trabalho.
import { JobQueue, openAmqp, startJobWorker } from '../../src/index.js';

const amqp = await openAmqp({ url: process.env['JOB_AMQP_URL']! });
await startJobWorker(amqp, new JobQueue(amqp, { name: process.env['JOB_QUEUE']! }), {
  prefetch: 1,
  handle: (job) => {
    console.log(`GOT ${job.jobId} ${job.deliveryCount}`);
    return new Promise(() => undefined); // nunca termina
  },
});
console.log('STARTED');
