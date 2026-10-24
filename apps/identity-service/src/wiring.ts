// Montagem do identity-service a partir do ambiente (usada pelo serviço e pelo CLI de bootstrap).
import { RealClock, TickedClock, type Clock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import {
  BlindIndex,
  createDatabase,
  FieldCipher,
  loadKeyring,
  parseKey,
} from '@broker/persistence';
import {
  Authenticator,
  BaseConfigProperties,
  createLogger,
  loadConfigOrExit,
  RevocationList,
} from '@broker/service-kit';
import { Valkey } from 'iovalkey';
import Type from 'typebox';
import { FieldProtectionAdapter, Argon2Hasher, nodeRandomness } from './adapters/crypto.js';
import { SmtpAndSinkMessenger } from './adapters/messenger.js';
import { JoseTokenSigner } from './adapters/token-signer.js';
import { OtplibTotp } from './adapters/totp.js';
import { SimpleWebAuthn } from './adapters/webauthn.js';
import { createIdentityService } from './app.js';

export const Config = Type.Object({
  ...BaseConfigProperties,
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ default: 5432 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
  STREAM_HOST: Type.String(),
  STREAM_PORT: Type.Integer({ default: 5552 }),
  STREAM_USER: Type.String(),
  STREAM_PASSWORD: Type.String(),
  VALKEY_HOST: Type.String(),
  VALKEY_PORT: Type.Integer({ default: 6379 }),
  VALKEY_PASSWORD: Type.String(),
  CLOCK_MODE: Type.Union(
    [Type.Literal('REAL'), Type.Literal('ACCELERATED'), Type.Literal('VIRTUAL')],
    { default: 'REAL' },
  ),
  CLOCK_START: Type.Optional(Type.String({ format: 'date-time' })),
  /** Chave-mestra da cifra de campo e chave do HMAC de busca (Docker secrets, D18). */
  FIELD_MASTER_KEY: Type.String(),
  BLIND_INDEX_KEY: Type.String(),
  /** Emissor e público dos tokens (os serviços validam com estes mesmos valores). */
  AUTH_ISSUER: Type.String({ default: 'https://auth.broker.localhost' }),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
  WEBAUTHN_RP_ID: Type.String({ default: 'broker.localhost' }),
  WEBAUTHN_ORIGINS: Type.String({
    default: 'https://app.broker.localhost,https://backoffice.broker.localhost',
  }),
  SMTP_HOST: Type.String({ default: 'mailpit' }),
  SMTP_PORT: Type.Integer({ default: 1025 }),
  MAIL_FROM: Type.String({ default: 'Broker <seguranca@broker.localhost>' }),
  MESSAGE_SINK_URL: Type.String({ default: 'http://message-sink:8080' }),
  RECOVERY_LINK_URL: Type.String({ default: 'https://app.broker.localhost/recuperar-acesso' }),
  INVITATION_LINK_URL: Type.String({ default: 'https://backoffice.broker.localhost/convite' }),
  /** Liga o consumo dos eventos do customer-service (tópico `customer`). */
  CONSUME_CUSTOMER_EVENTS: Type.Boolean({ default: false }),
});

/** Monta o serviço com a configuração do ambiente; o CLI de bootstrap dispensa o barramento. */
export async function wire({ withStream }: { withStream: boolean }) {
  const config = loadConfigOrExit(Config);
  const clock: Clock =
    config.CLOCK_MODE === 'REAL'
      ? new RealClock()
      : new TickedClock(
          config.CLOCK_MODE,
          config.CLOCK_START ? Instant.parse(config.CLOCK_START) : new RealClock().now(),
        );
  const logger = createLogger({
    service: config.SERVICE_NAME,
    environment: config.ENVIRONMENT,
    version: config.SERVICE_VERSION,
    level: config.LOG_LEVEL,
    clock,
  });
  const database = {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
  };
  const db = createDatabase(database);
  const fields = new FieldProtectionAdapter(
    new FieldCipher(await loadKeyring(db, parseKey(config.FIELD_MASTER_KEY, 'FIELD_MASTER_KEY'))),
    new BlindIndex(parseKey(config.BLIND_INDEX_KEY, 'BLIND_INDEX_KEY')),
  );
  const valkey = new Valkey({
    host: config.VALKEY_HOST,
    port: config.VALKEY_PORT,
    password: config.VALKEY_PASSWORD,
  });
  const revocation = new RevocationList(valkey);
  const signer = new JoseTokenSigner(db, fields, uuidv7, clock, {
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
  });
  const messenger = new SmtpAndSinkMessenger({
    smtpHost: config.SMTP_HOST,
    smtpPort: config.SMTP_PORT,
    from: config.MAIL_FROM,
    smsUrl: config.MESSAGE_SINK_URL,
  });

  const app = await createIdentityService({
    config,
    db,
    database,
    logger,
    clock,
    newId: uuidv7,
    hasher: new Argon2Hasher(),
    fields,
    random: nodeRandomness,
    signer,
    revocation,
    totp: new OtplibTotp(),
    webauthn: new SimpleWebAuthn({
      rpName: 'Broker',
      rpId: config.WEBAUTHN_RP_ID,
      origins: config.WEBAUTHN_ORIGINS.split(',').map((o) => o.trim()),
    }),
    messenger,
    links: { recovery: config.RECOVERY_LINK_URL, invitation: config.INVITATION_LINK_URL },
    // O próprio identity valida os tokens das rotas /v1/me pela sua JWKS, sem ida à rede.
    authenticator: new Authenticator({
      jwks: signer.keyResolver(),
      issuer: config.AUTH_ISSUER,
      audience: config.AUTH_AUDIENCE,
      clock,
      revocation,
    }),
    ...(withStream
      ? {
          stream: {
            host: config.STREAM_HOST,
            port: config.STREAM_PORT,
            user: config.STREAM_USER,
            password: config.STREAM_PASSWORD,
          },
        }
      : {}),
    consumeCustomerEvents: config.CONSUME_CUSTOMER_EVENTS,
  });
  const close = async () => {
    await db.destroy();
    await valkey.quit();
    messenger.close();
  };
  return { app, close };
}
