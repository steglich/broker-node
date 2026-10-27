// Gera os segredos locais em infra/secrets/ (fora do git), simulando o cofre (D18).
// Idempotente: só cria o que ainda não existe, então rodar de novo não troca senhas.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const infra = join(dirname(fileURLToPath(import.meta.url)), '..');
const secretsDir = join(infra, 'secrets');

const secret = () => randomBytes(24).toString('hex');

function ensure(relPath, value = secret()) {
  const file = join(secretsDir, relPath);
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, { mode: 0o644 });
  return true;
}

export function serviceCatalog() {
  return readFileSync(join(infra, 'postgres', 'services.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function generateSecrets() {
  const created = [];
  const add = (path, value) => ensure(path, value) && created.push(path);

  add('postgres_password');
  add('rabbitmq_password');
  add('valkey_password');
  add('minio_root_password');
  add('grafana_admin_password');
  // HMAC dos webhooks dos simuladores (RN-SIM-003), compartilhado com o receptor do núcleo.
  add('webhook/pix_simulator');
  add('webhook/kyc_simulator');
  // Cifra de campo (envelope encryption) e HMAC de busca por serviço (RN-DB-031, D18): 32 bytes.
  add('crypto/identity_field_master_key', randomBytes(32).toString('hex'));
  add('crypto/identity_blind_index_key', randomBytes(32).toString('hex'));
  add('crypto/customer_field_master_key', randomBytes(32).toString('hex'));
  add('crypto/customer_blind_index_key', randomBytes(32).toString('hex'));
  add('crypto/ledger_blind_index_key', randomBytes(32).toString('hex'));
  // Token de push cifrado e HMAC para achar o mesmo aparelho (notification-service).
  add('crypto/notification_field_master_key', randomBytes(32).toString('hex'));
  add('crypto/notification_blind_index_key', randomBytes(32).toString('hex'));
  // bff-web: HMAC do anti-CSRF e chave AES do cookie de login com MFA pendente.
  add('crypto/bff_web_csrf_secret', randomBytes(32).toString('hex'));
  add('crypto/bff_web_login_key', randomBytes(32).toString('hex'));
  // Tokens da brapi (RN-BRP-090/094): vazios por padrão, o local usa fixtures (RN-BRP-095). Para a
  // brapi real, escreva o token em brapi/token (e o próximo, na rotação, em brapi/token_next).
  add('brapi/token', '');
  add('brapi/token_next', '');
  for (const svc of serviceCatalog()) {
    add(`db/${svc}_app`);
    add(`db/${svc}_migrator`);
  }
  return created;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const created = generateSecrets();
  console.log(created.length ? `Segredos criados: ${created.join(', ')}` : 'Segredos já existem.');
}
