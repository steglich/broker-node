// RN-MSG-001: e-mail vai para a caixa de captura (Mailpit) e só os destinatários da lista de
// permissão saem para um SMTP real. O teste usa o MESMO bloco `environment` do serviço `mailpit`
// do compose, com um segundo Mailpit no papel do "SMTP real".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const compose = parse(
  readFileSync(
    fileURLToPath(new URL('../../../infra/compose/compose.yml', import.meta.url)),
    'utf8',
  ),
) as {
  services: { mailpit: { image: string; environment: Record<string, string> } };
};

/** Resolve `${VAR:-padrão}` como o docker compose faria, com `vars` no papel do ambiente. */
function composeEnvironment(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(compose.services.mailpit.environment).map(([k, v]) => [
      k,
      String(v).replace(
        /\$\{(\w+):-([^}]*)\}/g,
        (_m, name: string, fallback: string) => vars[name] ?? fallback,
      ),
    ]),
  );
}

async function mailpit(network: StartedNetwork, alias: string, env: Record<string, string>) {
  return new GenericContainer(compose.services.mailpit.image)
    .withNetwork(network)
    .withNetworkAliases(alias)
    .withEnvironment(env)
    .withExposedPorts(8025)
    .withWaitStrategy(Wait.forLogMessage(/\[http\] accessible/))
    .start();
}

async function send(container: StartedTestContainer, to: string) {
  const message = `From: noreply@broker.localhost\nTo: ${to}\nSubject: Nota de corretagem ${to}\n\nSua nota está disponível.\n`;
  const result = await container.exec(
    ['sh', '-c', `printf '%s' "$MSG" | /mailpit sendmail -S localhost:1025 ${to}`],
    {
      env: { MSG: message },
    },
  );
  expect(result.exitCode).toBe(0);
}

async function recipients(container: StartedTestContainer): Promise<string[]> {
  const res = await fetch(
    `http://${container.getHost()}:${container.getMappedPort(8025)}/api/v1/messages`,
  );
  const { messages } = (await res.json()) as {
    messages: Array<{ To: Array<{ Address: string }> }>;
  };
  return messages.flatMap((m) => m.To.map((t) => t.Address)).sort();
}

async function eventually(check: () => Promise<void>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

describe('Mailpit com lista de permissão (RN-MSG-001)', () => {
  let network: StartedNetwork;
  let realSmtp: StartedTestContainer;
  let capture: StartedTestContainer;

  beforeAll(async () => {
    network = await new Network().start();
    realSmtp = await mailpit(network, 'real-smtp', {});
    capture = await mailpit(
      network,
      'mailpit',
      composeEnvironment({
        MAIL_RELAY_HOST: 'real-smtp',
        MAIL_RELAY_PORT: '1025',
        MAIL_RELAY_STARTTLS: 'false',
        MAIL_RELAY_ALLOW_INSECURE: 'true',
        MAIL_RELAY_ALLOWLIST: '^dev@exemplo\\.com$',
      }),
    );
  });
  afterAll(async () => {
    await Promise.all([capture?.stop(), realSmtp?.stop()]);
    await network?.stop();
  });

  it('RN-MSG-001: e-mail fora da lista fica só na caixa de captura; o da lista também sai', async () => {
    await send(capture, 'cliente@gmail.com');
    await send(capture, 'dev@exemplo.com');
    await eventually(async () => {
      expect(await recipients(capture)).toEqual(['cliente@gmail.com', 'dev@exemplo.com']);
      expect(await recipients(realSmtp)).toEqual(['dev@exemplo.com']);
    });
    // Dá tempo de um relay indevido acontecer antes de afirmar que não aconteceu.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await recipients(realSmtp)).toEqual(['dev@exemplo.com']);
  });

  it('RN-MSG-001: sem lista configurada, o padrão do compose não repassa nada', () => {
    const env = composeEnvironment({});
    expect(env['MP_SMTP_RELAY_HOST']).toBe('');
    expect(env['MP_SMTP_RELAY_MATCHING']).toBe('');
    // Mesmo um "release" manual pela UI não pode sair: nenhum destinatário é permitido.
    expect(env['MP_SMTP_RELAY_ALLOWED_RECIPIENTS']).toBe('^$');
  });
});
