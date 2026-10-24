/**
 * Regras de documento (Onboarding §5.1, Segurança de aplicação §1: upload): JPEG, PNG ou PDF,
 * até 10 MB e no mínimo 800×600. O tipo vem dos bytes, nunca da extensão ou do Content-Type que o
 * cliente declarou. A mesma inspeção existe no KYC simulado, que olha o arquivo do lado dele.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MIN_WIDTH = 800;
export const MIN_HEIGHT = 600;
export const ACCEPTED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

export type DocumentType = 'ID_FRONT' | 'ID_BACK' | 'PROOF_OF_ADDRESS' | 'SELFIE';
/** A etapa de documentos termina com frente do documento e selfie aceitos. */
export const REQUIRED_DOCUMENTS: readonly DocumentType[] = ['ID_FRONT', 'SELFIE'];

export type DocumentFormat = 'JPEG' | 'PNG' | 'PDF';

export interface Inspection {
  format: DocumentFormat;
  width?: number;
  height?: number;
}

export type DocumentProblem =
  'TOO_LARGE' | 'UNSUPPORTED_FORMAT' | 'LOW_RESOLUTION' | 'NOT_UPLOADED';

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    const length = view.getUint16(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    i += 2 + length;
  }
  return undefined;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Formato e dimensões pelos bytes; `null` se não for JPEG, PNG ou PDF. */
export function inspect(b: Uint8Array): Inspection | null {
  if (b.length >= 24 && PNG.every((x, i) => b[i] === x)) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { format: 'PNG', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return size ? { format: 'JPEG', ...size } : null;
  }
  if (b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === '%PDF-')
    return { format: 'PDF' };
  return null;
}

/** Verifica o arquivo enviado: tamanho, formato pelos bytes e resolução mínima. */
export function checkDocument(size: number, head: Uint8Array | null): Inspection | DocumentProblem {
  if (head === null) return 'NOT_UPLOADED';
  if (size > MAX_DOCUMENT_BYTES) return 'TOO_LARGE';
  const i = inspect(head);
  if (!i) return 'UNSUPPORTED_FORMAT';
  if (i.width !== undefined && (i.width < MIN_WIDTH || (i.height ?? 0) < MIN_HEIGHT))
    return 'LOW_RESOLUTION';
  return i;
}
