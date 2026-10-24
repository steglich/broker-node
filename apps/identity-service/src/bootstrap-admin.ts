// CLI: convida o primeiro administrador do backoffice (BO_ADMIN), se ainda não houver um com o e-mail.
// Uso: node dist/bootstrap-admin.js <email> "<nome>". O convite (senha + TOTP) chega por e-mail.
import { wire } from './wiring.js';

const [email, fullName] = process.argv.slice(2);
if (!email || !fullName) {
  console.error('uso: bootstrap-admin <email> "<nome completo>"');
  process.exit(2);
}
const { app, close } = await wire({ withStream: false });
try {
  const result = await app.accounts.bootstrapAdmin(email, fullName);
  console.log(
    result ? `Convite enviado para ${email}.` : `Já existe um usuário do backoffice com ${email}.`,
  );
} finally {
  await close();
}
