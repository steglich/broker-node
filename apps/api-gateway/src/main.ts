// api-gateway (D9): borda HTTP atrás do Traefik, na frente dos BFFs.
import { RealClock } from '@broker/clock';
import {
  Authenticator,
  BaseConfigProperties,
  createLogger,
  loadConfigOrExit,
  RevocationList,
} from '@broker/service-kit';
import { Valkey } from 'iovalkey';
import Type from 'typebox';
import { createGateway } from './app.js';
import { parseChannelMap } from './edge.js';
import { ValkeyRateLimiter } from './rate-limit.js';

const Config = Type.Object({
  ...BaseConfigProperties,
  VALKEY_HOST: Type.String(),
  VALKEY_PORT: Type.Integer({ default: 6379 }),
  VALKEY_PASSWORD: Type.String(),
  AUTH_JWKS_URL: Type.String({ default: 'http://identity-service:8080/.well-known/jwks.json' }),
  AUTH_ISSUER: Type.String({ default: 'https://auth.broker.localhost' }),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
  /** `WEB=http://bff-web:8080,...`: canal sem BFF responde 503. */
  BFF_URLS: Type.String({ default: 'WEB=http://bff-web:8080' }),
  /** Versão mínima por canal (`426` abaixo dela). */
  MIN_CLIENT_VERSIONS: Type.String({
    default: 'WEB=1.0.0,MOBILE=1.0.0,DESKTOP=1.0.0,BACKOFFICE=1.0.0',
  }),
  CORS_ORIGINS: Type.String({
    default: 'https://app.broker.localhost,https://backoffice.broker.localhost',
  }),
  ACCESS_COOKIE: Type.String({ default: '__Host-broker_at' }),
  TRUSTED_PROXY_HOPS: Type.Integer({ default: 1, minimum: 0 }),
});

const config = loadConfigOrExit(Config);
// Limites e validade do token no relógio real: a borda não segue o relógio virtual do sandbox.
const clock = new RealClock();
const logger = createLogger({
  service: config.SERVICE_NAME,
  environment: config.ENVIRONMENT,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
  clock,
});
const valkey = new Valkey({
  host: config.VALKEY_HOST,
  port: config.VALKEY_PORT,
  password: config.VALKEY_PASSWORD,
});

const { service } = createGateway({
  config,
  clock,
  logger,
  authenticator: new Authenticator({
    jwks: new URL(config.AUTH_JWKS_URL),
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    clock,
    revocation: new RevocationList(valkey),
  }),
  limiter: new ValkeyRateLimiter(valkey),
  bffs: parseChannelMap(config.BFF_URLS),
  minVersions: parseChannelMap(config.MIN_CLIENT_VERSIONS),
  allowedOrigins: config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  accessCookie: config.ACCESS_COOKIE,
  trustedProxyHops: config.TRUSTED_PROXY_HOPS,
  readiness: { valkey: () => valkey.ping() },
});

service.onShutdown('valkey', async () => valkey.quit());
await service.start();
