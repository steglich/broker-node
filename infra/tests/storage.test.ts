import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hosts, secret } from './env.js';

const s3 = new S3Client({
  endpoint: `http://localhost:${hosts.minioPort}`,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'broker', secretAccessKey: secret('minio_root_password') },
});

const composeFile = fileURLToPath(new URL('../compose/compose.yml', import.meta.url));
const valkey = (...args: string[]): string =>
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      composeFile,
      'exec',
      '-T',
      'valkey',
      'sh',
      '-c',
      `valkey-cli -a "$(cat /run/secrets/valkey_password)" --no-auth-warning ${args.join(' ')}`,
    ],
    { encoding: 'utf8' },
  ).trim();

describe('MinIO', () => {
  it('D16: tem os buckets documents, reports, brapi-raw e audit-anchors', async () => {
    const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets.map((b) => b.Name)).toEqual(
      expect.arrayContaining(['documents', 'reports', 'brapi-raw', 'audit-anchors']),
    );
  });

  it('RN-AUD-002: uma âncora gravada em audit-anchors não pode ser sobrescrita nem apagada', async () => {
    const Bucket = 'audit-anchors';
    const Key = `infra-test/${randomUUID()}.json`;
    const original = await s3.send(
      new PutObjectCommand({ Bucket, Key, Body: '{"hash":"original"}' }),
    );
    expect(original.VersionId).toBeTruthy();

    // Um novo PUT na mesma chave não altera a versão gravada: o bucket versionado cria outra versão.
    const second = await s3.send(
      new PutObjectCommand({ Bucket, Key, Body: '{"hash":"adulterado"}' }),
    );
    expect(second.VersionId).not.toBe(original.VersionId);
    const stored = await s3.send(
      new GetObjectCommand({ Bucket, Key, VersionId: original.VersionId }),
    );
    expect(await stored.Body?.transformToString()).toBe('{"hash":"original"}');

    // Apagar a versão gravada é recusado pelo object lock em modo COMPLIANCE, inclusive para o usuário raiz.
    await expect(
      s3.send(new DeleteObjectCommand({ Bucket, Key, VersionId: original.VersionId })),
    ).rejects.toThrow(/WORM protected/);
  });
});

describe('Valkey', () => {
  it('D16: roda sem persistência (sem RDB e sem AOF)', () => {
    expect(valkey('CONFIG', 'GET', 'save')).toBe('save');
    expect(valkey('CONFIG', 'GET', 'appendonly')).toBe('appendonly\nno');
  });
});
