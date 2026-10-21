import { fileURLToPath } from 'node:url';

/** Raiz do pacote `contracts/` (as CLIs rodam do código-fonte, com tsx). */
export const CONTRACTS_ROOT = fileURLToPath(new URL('../../', import.meta.url));
