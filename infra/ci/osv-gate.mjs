// Lê o JSON do osv-scanner e reprova só vulnerabilidades altas ou críticas (CVSS ≥ 7, RN-CICD §2:
// "SAST, SCA, varredura de segredos — bloqueia em críticas/altas"). As demais aparecem como aviso.
import { readFileSync } from 'node:fs';

const BLOCKING = 7.0;
const report = JSON.parse(readFileSync(process.argv[2] ?? '/dev/stdin', 'utf8'));
let blocking = 0;
for (const result of report.results ?? []) {
  for (const pkg of result.packages ?? []) {
    for (const group of pkg.groups ?? []) {
      const severity = Number(group.max_severity || 0);
      const line = `${pkg.package.name}@${pkg.package.version}: ${group.ids.join(', ')} (CVSS ${group.max_severity || '?'})`;
      if (severity >= BLOCKING || !group.max_severity) {
        blocking++;
        console.log(`::error::${line}`);
      } else {
        console.log(`::warning::${line}`);
      }
    }
  }
}
console.log(
  blocking
    ? `${blocking} vulnerabilidade(s) alta(s)/crítica(s)`
    : 'nenhuma vulnerabilidade alta ou crítica',
);
process.exitCode = blocking ? 1 : 0;
