import { describe, expect, it } from 'vitest';
import { ANONYMOUS, runWithContext } from '../src/index.js';
import { memoryLogger } from './helpers.js';
import { Instant } from '@broker/domain-kernel';

describe('logs estruturados (RN-BE-050..052)', () => {
  it('RN-BE-050: JSON com os campos mínimos, timestamp do relógio do ambiente e wall_clock_at da máquina', () => {
    const { logger, lines } = memoryLogger();
    runWithContext(
      {
        actor: ANONYMOUS,
        correlationId: 'corr-1',
        channel: 'WEB',
        requestedAt: Instant.parse('2027-01-04T13:00:00Z'),
        scopes: new Set(),
        roles: new Set(),
      },
      () =>
        logger.info(
          { event: 'order.accepted', account_id: 'acc-1', order_id: 'o-1' },
          'ordem aceita',
        ),
    );
    const line = lines[0]!;
    expect(line).toMatchObject({
      level: 'INFO',
      service: 'test-service',
      environment: 'prod',
      version: '1.2.3',
      correlation_id: 'corr-1',
      message: 'ordem aceita',
      event: 'order.accepted',
      account_id: 'acc-1',
      timestamp: '2027-01-04T13:00:00.000Z', // relógio virtual do ambiente
    });
    // wall_clock_at é o relógio real da máquina (RN-CLK-004): diferente do virtual.
    expect(Math.abs(Date.parse(line['wall_clock_at'] as string) - Date.now())).toBeLessThan(5000);
  });

  it('RN-BE-051: password, token e taxId saem mascarados, em qualquer profundidade e grafia', () => {
    const { logger, lines } = memoryLogger();
    logger.info(
      {
        event: 'auth.login_attempt',
        password: 'S3nh@!',
        body: {
          refresh_token: 'rt-123',
          user: { taxId: '52998224725', email: 'a@b.c' },
          Authorization: 'Bearer abc',
        },
        items: [{ cpf: '529.982.247-25' }, { client_secret: 'x' }],
        document: 'RG 12.345.678-9',
      },
      'tentativa de login',
    );
    const out = JSON.stringify(lines[0]);
    for (const leaked of [
      'S3nh@!',
      'rt-123',
      '52998224725',
      'Bearer abc',
      '529.982.247-25',
      '12.345.678-9',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(lines[0]).toMatchObject({
      password: '[REDACTED]',
      body: {
        refresh_token: '[REDACTED]',
        user: { taxId: '***.982.247-**' },
        Authorization: '[REDACTED]',
      },
      items: [{ cpf: '***.982.247-**' }, { client_secret: '[REDACTED]' }],
      document: '[REDACTED]',
    });
  });

  it('RN-BE-052: DEBUG desligado no nível padrão; erros levam o stack no campo err', () => {
    const { logger, lines } = memoryLogger();
    logger.debug({ event: 'x' }, 'não deve sair');
    logger.error({ event: 'db.failed', err: new Error('conexão recusada') }, 'falhou');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'ERROR',
      err: { message: 'conexão recusada', type: 'Error' },
    });
  });
});
