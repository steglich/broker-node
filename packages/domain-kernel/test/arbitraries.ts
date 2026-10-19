import fc from 'fast-check';

/** String decimal com até `scale` casas, ex.: "-123.45". */
export const decimalString = (scale = 8, maxInt = 10n ** 12n) =>
  fc
    .tuple(
      fc.bigInt({ min: -maxInt, max: maxInt }),
      fc.bigInt({ min: 0n, max: 10n ** BigInt(scale) - 1n }),
    )
    .map(([int, frac]) => {
      const sign = int < 0n ? '-' : '';
      const abs = int < 0n ? -int : int;
      return scale === 0
        ? `${sign}${abs}`
        : `${sign}${abs}.${frac.toString().padStart(scale, '0')}`;
    });

/** Converte string decimal em inteiro escalado (aritmética exata de referência). */
export const scaled = (s: string, scale: number): bigint => {
  const neg = s.startsWith('-');
  const [i = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i) * 10n ** BigInt(scale) + BigInt(f.padEnd(scale, '0') || '0');
  return neg ? -v : v;
};
