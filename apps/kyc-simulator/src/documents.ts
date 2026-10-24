/** Limites de DOCUMENT_QUALITY (Onboarding §5.1): JPEG, PNG ou PDF, até 10 MB, mínimo 800×600. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MIN_WIDTH = 800;
export const MIN_HEIGHT = 600;

/**
 * A referência precisa ser uma URL pré-assinada (SigV4 do S3/MinIO): com assinatura e validade.
 * Um link público e permanente para o documento seria exatamente o que RN-KYCS-001 quer evitar.
 */
export function isSignedUrl(url: string): boolean {
  try {
    const q = new URL(url).searchParams;
    return q.has('X-Amz-Signature') && q.has('X-Amz-Expires') && q.has('X-Amz-Date');
  } catch {
    return false;
  }
}

export type DocumentFormat = 'JPEG' | 'PNG' | 'PDF';

export interface Inspection {
  format: DocumentFormat;
  bytes: number;
  width?: number;
  height?: number;
}

export type DocumentProblem =
  'REFERENCE_UNAVAILABLE' | 'TOO_LARGE' | 'UNSUPPORTED_FORMAT' | 'LOW_RESOLUTION';

function jpegSize(b: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    const length = b.readUInt16BE(i + 2);
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC): altura e largura do quadro.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return undefined;
}

/** Formato pelos bytes iniciais (não pela extensão ou Content-Type, que o cliente controla). */
export function inspectDocument(b: Buffer): Inspection | 'UNSUPPORTED_FORMAT' {
  if (
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return {
      format: 'PNG',
      bytes: b.length,
      width: b.readUInt32BE(16),
      height: b.readUInt32BE(20),
    };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return size ? { format: 'JPEG', bytes: b.length, ...size } : 'UNSUPPORTED_FORMAT';
  }
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return { format: 'PDF', bytes: b.length };
  return 'UNSUPPORTED_FORMAT';
}

/**
 * Lê o documento pela URL assinada e analisa EM MEMÓRIA; os bytes não são gravados em lugar nenhum
 * (RN-KYCS-001). URL vencida ou inválida → o storage responde 403 → `REFERENCE_UNAVAILABLE`.
 */
export async function fetchAndInspect(
  url: string,
  timeoutMs = 10_000,
): Promise<Inspection | DocumentProblem> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return 'REFERENCE_UNAVAILABLE';
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    return 'REFERENCE_UNAVAILABLE';
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await res.body.cancel().catch(() => undefined);
      return 'TOO_LARGE';
    }
    chunks.push(Buffer.from(chunk));
  }
  const inspection = inspectDocument(Buffer.concat(chunks));
  if (inspection === 'UNSUPPORTED_FORMAT') return inspection;
  if (
    inspection.width !== undefined &&
    (inspection.width < MIN_WIDTH || inspection.height! < MIN_HEIGHT)
  ) {
    return 'LOW_RESOLUTION';
  }
  return inspection;
}
