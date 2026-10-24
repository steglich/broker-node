import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { DocumentStorage } from '../application/ports.js';

export interface S3Settings {
  /** Endereço que o serviço usa para falar com o MinIO. */
  endpoint: string;
  /**
   * Endereço das URLs de upload (o que o navegador enxerga, ex.: `http://localhost:9000`); padrão =
   * endpoint. As URLs de leitura vão para o KYC, dentro da rede, e usam o endpoint interno: o host
   * faz parte da assinatura, então cada URL é assinada com o endereço de quem vai usá-la.
   */
  publicEndpoint?: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

const HEAD_BYTES = 64 * 1024;

const client = (endpoint: string, s: S3Settings) =>
  new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
  });

/**
 * Documentos no bucket `documents` (D16): upload e download só por URL pré-assinada. O PUT assinado
 * fixa o Content-Type e o Content-Length declarados; mesmo assim o serviço confere o arquivo depois
 * (o cliente controla o que declara, não o que o servidor lê).
 */
export class S3DocumentStorage implements DocumentStorage {
  private readonly s3: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly s: S3Settings) {
    this.s3 = client(s.endpoint, s);
    this.signer = client(s.publicEndpoint ?? s.endpoint, s);
  }

  uploadUrl(key: string, contentType: string, size: number, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.s.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      }),
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  downloadUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.s.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async inspect(key: string) {
    let size: number;
    try {
      size =
        (await this.s3.send(new HeadObjectCommand({ Bucket: this.s.bucket, Key: key })))
          .ContentLength ?? 0;
    } catch (err) {
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return null;
      throw err;
    }
    // Grande demais: nem baixa (o tamanho já reprova).
    if (size > 10 * 1024 * 1024) return { size, sha256: '', head: new Uint8Array() };
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.s.bucket, Key: key }));
    const bytes = await obj.Body!.transformToByteArray();
    return {
      size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      head: bytes.subarray(0, HEAD_BYTES),
    };
  }

  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.s.bucket, Key: key }));
  }

  destroy(): void {
    this.s3.destroy();
    this.signer.destroy();
  }
}
