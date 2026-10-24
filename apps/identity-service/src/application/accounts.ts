import { DomainError, TaxId } from '@broker/domain-kernel';
import { checkPassword, PASSWORD_MESSAGES } from '../domain/password-policy.js';
import { isBackofficeRole, roleConflict } from '../domain/policies.js';
import {
  CTX,
  IdentityError,
  normalizeEmail,
  requireUser,
  type Caller,
  type IdentityDeps,
} from './context.js';
import type { IdentityTx, UserRow } from './ports.js';

const INVITATION_TTL_MS = 72 * 3_600_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Contas de acesso: cadastro do cliente (RN-AUTH-001), usuários e papéis do backoffice (RN-BO-001),
 * clientes OAuth de serviço e a ligação usuário → cliente → conta (eventos do customer-service).
 */
export class Accounts {
  constructor(private readonly d: IdentityDeps) {}

  /** Valida a senha contra a política; lança erro de validação no campo `password`. */
  assertPassword(
    password: string,
    ctx: { email: string; fullName?: string | null; taxId?: string | null },
  ) {
    const violation = checkPassword(password, ctx);
    if (violation)
      throw new IdentityError(400, violation, PASSWORD_MESSAGES[violation], 'password');
  }

  /** Cadastro self-service, só no realm `customers` (o backoffice não tem rota de cadastro). */
  async registerCustomer(input: {
    email: string;
    password: string;
    fullName: string;
    taxId: string;
  }): Promise<{ userId: string }> {
    const email = normalizeEmail(input.email);
    if (!EMAIL.test(email))
      throw new IdentityError(400, 'INVALID_EMAIL', 'E-mail inválido.', 'email');
    let taxId: TaxId;
    try {
      taxId = TaxId.parse(input.taxId);
    } catch (err) {
      if (err instanceof DomainError) throw new IdentityError(400, err.code, err.message, 'taxId');
      throw err;
    }
    this.assertPassword(input.password, { email, fullName: input.fullName, taxId: taxId.digits });
    const passwordHash = await this.d.hasher.hash(input.password);
    const now = this.d.clock.now();
    const user: UserRow = {
      id: this.d.newId(),
      realm: 'customers',
      emailHash: this.d.fields.emailHash(email),
      emailEnc: this.d.fields.seal(email, CTX.email),
      nameEnc: this.d.fields.seal(input.fullName.trim(), CTX.name),
      taxIdEnc: this.d.fields.seal(taxId.digits, CTX.taxId),
      status: 'ACTIVE',
      customerId: null,
      accountId: null,
      desktopIdleMs: null,
      createdAt: now,
    };
    await this.d.store.transaction(async (tx) => {
      if (!(await tx.insertUser(user))) {
        throw new IdentityError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'Já existe um cadastro com esse e-mail.',
          'email',
        );
      }
      await tx.setPassword(user.id, passwordHash, now);
      await tx.publish(
        {
          type: 'identity.user_registered',
          payload: {
            userId: user.id,
            realm: 'customers',
            emailHash: user.emailHash,
            registeredAt: now.toString(),
          },
        },
        user.id,
      );
    });
    return { userId: user.id };
  }

  /** E-mail, nome e CPF em claro, para a política de senha e as mensagens. */
  profile(user: UserRow): { email: string; fullName: string | null; taxId: string | null } {
    return {
      email: this.d.fields.open(user.emailEnc, CTX.email),
      fullName: user.nameEnc ? this.d.fields.open(user.nameEnc, CTX.name) : null,
      taxId: user.taxIdEnc ? this.d.fields.open(user.taxIdEnc, CTX.taxId) : null,
    };
  }

  // ---------------------------------------------------------------- backoffice

  /**
   * Convite de um usuário do backoffice (sem cadastro self-service, RN-BO-002). Ele define a senha
   * e ativa o TOTP no mesmo passo: não existe conta de backoffice sem MFA forte.
   */
  async inviteBackofficeUser(input: {
    email: string;
    fullName: string;
    roles: string[];
  }): Promise<{ userId: string; link: string }> {
    const email = normalizeEmail(input.email);
    if (!EMAIL.test(email))
      throw new IdentityError(400, 'INVALID_EMAIL', 'E-mail inválido.', 'email');
    this.assertRoles(input.roles);
    const now = this.d.clock.now();
    const user: UserRow = {
      id: this.d.newId(),
      realm: 'backoffice',
      emailHash: this.d.fields.emailHash(email),
      emailEnc: this.d.fields.seal(email, CTX.email),
      nameEnc: this.d.fields.seal(input.fullName.trim(), CTX.name),
      taxIdEnc: null,
      status: 'PENDING',
      customerId: null,
      accountId: null,
      desktopIdleMs: null,
      createdAt: now,
    };
    const token = this.d.random.token();
    await this.d.store.transaction(async (tx) => {
      if (!(await tx.insertUser(user))) {
        throw new IdentityError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'Já existe um usuário com esse e-mail.',
          'email',
        );
      }
      await tx.setRoles(user.id, input.roles);
      await tx.insertOneTimeToken({
        tokenHash: this.d.random.sha256(token),
        purpose: 'INVITATION',
        userId: user.id,
        otpHash: null,
        otpAttempts: 0,
        expiresAt: now.plusMillis(INVITATION_TTL_MS),
        usedAt: null,
      });
      await tx.publish(
        {
          type: 'identity.user_registered',
          payload: {
            userId: user.id,
            realm: 'backoffice',
            emailHash: user.emailHash,
            registeredAt: now.toString(),
          },
        },
        user.id,
      );
    });
    const link = `${this.d.links.invitation}?token=${token}`;
    await this.d.messenger.email(
      email,
      'Convite para o backoffice',
      `Você foi convidado para o backoffice. Defina sua senha e ative o autenticador em até 72 horas:\n\n${link}`,
    );
    return { userId: user.id, link };
  }

  /** Papéis de um usuário do backoffice, com a segregação de funções (RN-BO-001). */
  async setRoles(caller: Caller, userId: string, roles: string[]): Promise<void> {
    this.assertRoles(roles);
    await this.d.store.transaction(async (tx) => {
      const user = await requireUser(tx, userId);
      if (user.realm !== 'backoffice')
        throw new IdentityError(404, 'NOT_FOUND', 'Usuário inexistente.');
      if (userId === caller.userId)
        throw new IdentityError(403, 'SELF_ROLE_CHANGE', 'Ninguém altera os próprios papéis.');
      await tx.setRoles(userId, roles);
    });
  }

  private assertRoles(roles: string[]): void {
    if (roles.length === 0)
      throw new IdentityError(400, 'ROLES_REQUIRED', 'Informe ao menos um papel.', 'roles');
    const unknown = roles.find((r) => !isBackofficeRole(r));
    if (unknown)
      throw new IdentityError(400, 'UNKNOWN_ROLE', `Papel desconhecido: ${unknown}.`, 'roles');
    const conflict = roleConflict(roles);
    if (conflict) throw new IdentityError(422, 'SEGREGATION_OF_DUTIES', conflict, 'roles');
  }

  /** Cliente OAuth de serviço (client credentials, Autenticação §5.1); o segredo aparece uma vez. */
  async registerServiceClient(input: {
    clientId: string;
    scopes: string[];
  }): Promise<{ clientId: string; clientSecret: string }> {
    const secret = this.d.random.token();
    const secretHash = await this.d.hasher.hash(secret);
    await this.d.store.transaction(async (tx) => {
      if (await tx.client(input.clientId))
        throw new IdentityError(
          409,
          'CLIENT_EXISTS',
          'Já existe um cliente com esse id.',
          'clientId',
        );
      await tx.insertClient({
        clientId: input.clientId,
        realm: 'services',
        type: 'CONFIDENTIAL',
        channel: null,
        secretHash,
        redirectUris: [],
        allowedScopes: [...new Set(input.scopes)].sort(),
      });
    });
    return { clientId: input.clientId, clientSecret: secret };
  }

  /** Primeiro administrador do backoffice (CLI de bootstrap); não faz nada se já existir um. */
  async bootstrapAdmin(email: string, fullName: string): Promise<{ link: string } | null> {
    const exists = await this.d.store.transaction(async (tx) =>
      tx.userByEmail('backoffice', this.d.fields.emailHash(normalizeEmail(email))),
    );
    if (exists) return null;
    const { link } = await this.inviteBackofficeUser({ email, fullName, roles: ['BO_ADMIN'] });
    return { link };
  }

  // ---------------------------------------------------------------- usuário → cliente → conta

  /** `customer.created`: o usuário passa a ter cliente (e a conta, se já foi aberta). */
  async onCustomerCreated(
    tx: IdentityTx,
    e: { customerId: string; userId: string },
  ): Promise<void> {
    const user = await tx.userById(e.userId, { forUpdate: true });
    if (!user) return;
    const [accountId] = await tx.accountsOfCustomer(e.customerId);
    await tx.updateUser(user.id, {
      customerId: e.customerId,
      ...(accountId && !user.accountId ? { accountId } : {}),
    });
  }

  /** `account.opened`: os tokens seguintes levam `account_id` (Autenticação §4). */
  async onAccountOpened(
    tx: IdentityTx,
    e: { accountId: string; customerId: string },
  ): Promise<void> {
    await tx.linkCustomerAccount(e.customerId, e.accountId);
    for (const user of await tx.usersByCustomer(e.customerId)) {
      if (!user.accountId) await tx.updateUser(user.id, { accountId: e.accountId });
    }
  }

  /** `account.status_changed` para `BLOCKED`: revoga as assinaturas do titular (RN-AUTH-014). */
  async onAccountStatusChanged(
    tx: IdentityTx,
    e: { accountId: string; to: string },
  ): Promise<number> {
    if (e.to !== 'BLOCKED') return 0;
    const now = this.d.clock.now();
    let revoked = 0;
    for (const user of await tx.usersByAccount(e.accountId)) {
      for (const t of await tx.revokeSignatureTokens({ userId: user.id }, now)) {
        await this.d.revocation.revokeSignature(t.jti, t.expiresAt.epochMillis - now.epochMillis);
        revoked++;
      }
    }
    return revoked;
  }
}
