import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { RawStorage } from '../application/ports.js';

export interface RawStorageSettings {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  /** `brapi-raw`: expira em 30 dias pela regra de ciclo de vida do bucket (RN-BRP-061). */
  bucket: string;
}

/** Corpo bruto das respostas da brapi no MinIO (D16), para depurar o adaptador. */
export class S3RawStorage implements RawStorage {
  private readonly s3: S3Client;

  constructor(private readonly s: RawStorageSettings) {
    this.s3 = new S3Client({
      endpoint: s.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
    });
  }

  async put(key: string, body: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.s.bucket,
        Key: key,
        Body: body,
        ContentType: key.endsWith('.json') ? 'application/json' : 'text/plain',
      }),
    );
  }
}

/** Sem armazenamento (testes; o hash do corpo continua no histórico). */
export class MemoryRawStorage implements RawStorage {
  readonly objects = new Map<string, string>();

  async put(key: string, body: string): Promise<void> {
    this.objects.set(key, body);
  }
}
