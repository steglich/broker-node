// Adaptadores de infraestrutura: cache no Valkey e corpo bruto no MinIO (D16, RN-BRP-061).
import { CreateBucketCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Instant } from '@broker/domain-kernel';
import {
  startMinio,
  startValkey,
  type StartedMinio,
  type StartedValkey,
} from '@broker/testing/containers';
import { Valkey } from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValkeyProviderCache } from '../src/adapters/cache.js';
import { S3RawStorage } from '../src/adapters/raw-storage.js';

let valkey: StartedValkey;
let minio: StartedMinio;
beforeAll(async () => {
  [valkey, minio] = await Promise.all([startValkey(), startMinio()]);
}, 180_000);
afterAll(async () => {
  await valkey?.container.stop();
  await minio?.container.stop();
});

describe('adaptadores de infraestrutura', () => {
  it('cache da brapi no Valkey: grava com validade e expira', async () => {
    const client = new Valkey({ host: valkey.host, port: valkey.port });
    const cache = new ValkeyProviderCache(client);
    const at = Instant.parse('2026-10-27T14:00:00Z');
    expect(await cache.get('quote:PETR4')).toBeNull();
    await cache.set('quote:PETR4', { lastPrice: '38.45' }, at, 200);
    expect(await cache.get('quote:PETR4')).toEqual({ value: { lastPrice: '38.45' }, storedAt: at });
    expect(await client.pttl('md:quote:PETR4')).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(await cache.get('quote:PETR4')).toBeNull();
    await client.quit();
  });

  it('corpo bruto no bucket brapi-raw', async () => {
    const s3 = new S3Client({
      endpoint: minio.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
    });
    await s3.send(new CreateBucketCommand({ Bucket: 'brapi-raw' }));
    const storage = new S3RawStorage({
      endpoint: minio.endpoint,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'brapi-raw',
    });
    await storage.put('2026-10-27/PETR4/abc.json', '{"results":[]}');
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: 'brapi-raw', Key: '2026-10-27/PETR4/abc.json' }),
    );
    expect(await obj.Body!.transformToString()).toBe('{"results":[]}');
    expect(obj.ContentType).toBe('application/json');
  });
});
