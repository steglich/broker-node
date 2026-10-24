import type { Clock } from '@broker/clock';
import { AccountOpenedV1 } from '@broker/contracts/events/account.opened/v1';
import { AccountStatusChangedV1 } from '@broker/contracts/events/account.status_changed/v1';
import { CustomerCreatedV1 } from '@broker/contracts/events/customer.created/v1';
import {
  connectStream,
  ensureSuperStream,
  EventConsumer,
  EventPublisher,
  OutboxRelay,
  PartitionedProducer,
  topicName,
  type StreamSettings,
} from '@broker/messaging';
import type { DatabaseConfig } from '@broker/persistence';
import {
  createService,
  type Authenticator,
  type BaseConfig,
  type Logger,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresIdentityStore } from './adapters/postgres-store.js';
import type { JoseTokenSigner } from './adapters/token-signer.js';
import { Accounts } from './application/accounts.js';
import { Auth } from './application/auth.js';
import type { IdentityDeps } from './application/context.js';
import { Factors } from './application/factors.js';
import { Recovery } from './application/recovery.js';
import { TradingSignature } from './application/signature.js';

export interface IdentityServiceDeps extends Omit<IdentityDeps, 'store' | 'signer'> {
  config: BaseConfig;
  db: Kysely<unknown>;
  /** Credenciais do banco para o LISTEN do relay. */
  database: DatabaseConfig;
  logger: Logger;
  clock: Clock;
  signer: JoseTokenSigner;
  /** Valida os tokens das rotas `/v1/me` e de administração (as do próprio identity). */
  authenticator: Authenticator;
  /** Sem stream: só banco e HTTP (testes); com stream, relay e consumidores. */
  stream?: StreamSettings;
  /** Consome `customer.created`, `account.opened` e `account.status_changed` do tópico `customer`. */
  consumeCustomerEvents?: boolean;
}

/** Monta o identity-service (catálogo de serviços §1, Autenticação §1–§5). */
export async function createIdentityService(d: IdentityServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresIdentityStore(d.db, publisher);
  const deps: IdentityDeps = { ...d, store };
  const factors = new Factors(deps);
  const accounts = new Accounts(deps);
  const auth = new Auth(deps, factors);
  const signature = new TradingSignature(deps);
  const recovery = new Recovery(deps, auth, factors, accounts);
  await d.signer.ensureKey(d.clock.now());

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'identity');
    await ensureSuperStream(client, superStream, { maxAge: '30D' });
    relay = new OutboxRelay({
      db: d.db,
      listenConfig: d.database,
      producer: await PartitionedProducer.create(
        client,
        superStream,
        `${d.config.SERVICE_NAME}.outbox`,
      ),
      clock: d.clock,
      onError: (err) => d.logger.error({ event: 'outbox.relay_failed', err }, 'falha no relay'),
    });
    if (d.consumeCustomerEvents) {
      consumers.push(
        new EventConsumer({
          name: 'identity.customer',
          environment,
          superStream: topicName(environment, 'customer'),
          stream: d.stream,
          db: d.db,
          // Os três handlers comutam: a ordem entre cliente e conta não importa (customer_account).
          ordered: false,
          newId: d.newId,
          onError: (err) =>
            d.logger.error({ event: 'consumer.failed', err }, 'falha no consumidor'),
          handlers: {
            'customer.created': {
              definition: CustomerCreatedV1,
              handle: (trx, e) =>
                accounts.onCustomerCreated(
                  store.tx(trx),
                  e.payload as { customerId: string; userId: string },
                ),
            },
            'account.opened': {
              definition: AccountOpenedV1,
              handle: (trx, e) =>
                accounts.onAccountOpened(
                  store.tx(trx),
                  e.payload as { accountId: string; customerId: string },
                ),
            },
            'account.status_changed': {
              definition: AccountStatusChangedV1,
              handle: async (trx, e) => {
                const p = e.payload as { accountId: string; to: string };
                const revoked = await accounts.onAccountStatusChanged(store.tx(trx), p);
                if (revoked > 0)
                  d.logger.info(
                    { event: 'identity.signatures_revoked', accountId: p.accountId, revoked },
                    'assinaturas revogadas',
                  );
              },
            },
          },
        }),
      );
    }
  }

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    authenticator: d.authenticator,
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, {
    accounts,
    auth,
    factors,
    signature,
    recovery,
    signer: d.signer,
    clock: d.clock,
  });

  return {
    service,
    store,
    accounts,
    auth,
    factors,
    signature,
    recovery,
    async start() {
      await relay?.start();
      for (const c of consumers) await c.start();
    },
    async stop() {
      for (const c of consumers) await c.stop();
      await relay?.stop();
      await closeStream?.();
    },
  };
}
