import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { AnchorConflictError, type AnchorStorage } from '../application/ports.js';

export interface S3Settings {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

const status = (err: unknown) =>
  err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;

/**
 * Âncoras no bucket `audit-anchors` do MinIO (D16, RN-AUD-002). O bucket tem object lock em modo
 * COMPLIANCE: nenhuma versão gravada pode ser apagada ou alterada, nem pelo usuário raiz. Além
 * disso, o PUT é condicional (`If-None-Match: *`): a chave do dia só é escrita uma vez, e uma
 * segunda escrita nem cria versão nova.
 */
export class S3AnchorStorage implements AnchorStorage {
  private readonly s3: S3Client;

  constructor(private readonly settings: S3Settings) {
    this.s3 = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region ?? 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
    });
  }

  async putOnce(key: string, body: string): Promise<{ versionId: string | null }> {
    try {
      const res = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.settings.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
      return { versionId: res.VersionId ?? null };
    } catch (err) {
      // 412: a chave já existe. Mesmo conteúdo é re-execução; outro conteúdo é conflito.
      if (status(err) !== 412) throw err;
      const existing = await this.read(key);
      if (existing?.body === body) return { versionId: existing.versionId };
      throw new AnchorConflictError(`a âncora ${key} já existe com outro conteúdo`);
    }
  }

  async get(key: string): Promise<string | null> {
    return (await this.read(key))?.body ?? null;
  }

  private async read(key: string): Promise<{ body: string; versionId: string | null } | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }),
      );
      return {
        body: (await res.Body?.transformToString()) ?? '',
        versionId: res.VersionId ?? null,
      };
    } catch (err) {
      if (status(err) === 404) return null;
      throw err;
    }
  }

  destroy(): void {
    this.s3.destroy();
  }
}
