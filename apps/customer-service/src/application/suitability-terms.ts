import { createHash } from 'node:crypto';
import type { BusinessDate } from '@broker/domain-kernel';
import {
  profileFor,
  score,
  SUITABILITY_WARNING_DAYS,
  suitabilityValidUntil,
  SuitabilityError,
} from '../domain/suitability.js';
import { CustomerError, notFound, rule, type Caller, type CustomerDeps } from './context.js';
import type { Onboarding } from './onboarding.js';
import type { AssessmentRow, CustomerTx, TermsRow } from './ports.js';

/**
 * Suitability (RN-SUI-001..013) e termos (RN-TER-001/002). Durante o onboarding, concluem as
 * etapas `SUITABILITY` e `TERMS`; depois, um perfil novo sai como `suitability.assessed`.
 */
export class SuitabilityAndTerms {
  constructor(
    private readonly d: CustomerDeps,
    private readonly onboarding: Onboarding,
  ) {}

  // ---------------------------------------------------------------- suitability

  /** Questionário vigente, sem os pesos (o cliente não escolhe a resposta pela pontuação). */
  async questionnaire() {
    const q = await this.d.store.transaction((tx) => tx.currentQuestionnaire());
    return {
      version: q.version,
      questions: q.questions.map((x) => ({
        id: x.id,
        text: x.text,
        options: x.options.map((o) => ({ id: o.id, text: o.text })),
      })),
    };
  }

  async assess(
    caller: Caller,
    input: { questionnaireVersion: number; answers: Record<string, string> },
  ) {
    return this.d.store.transaction(async (tx) => {
      const q = await tx.currentQuestionnaire();
      if (input.questionnaireVersion !== q.version)
        throw new CustomerError(
          409,
          'QUESTIONNAIRE_OUTDATED',
          `Responda a versão ${q.version} do questionário.`,
        );
      let points: number;
      try {
        points = score(q, input.answers);
      } catch (err) {
        if (err instanceof SuitabilityError)
          throw new CustomerError(400, err.code, err.message, 'answers');
        throw err;
      }
      const now = this.d.clock.now();
      const assessment: AssessmentRow = {
        id: this.d.newId(),
        userId: caller.userId,
        questionnaireId: q.id,
        questionnaireVersion: q.version,
        answers: input.answers,
        score: points,
        profile: profileFor(q, points),
        assessedAt: now,
        validUntil: suitabilityValidUntil(now.businessDate()),
        expiringNotified: false,
        expiredNotified: false,
      };
      await tx.insertAssessment(assessment);
      const customer = await tx.customerOfUser(caller.userId);
      if (customer) {
        // RN-SUI-013: vale a mais recente.
        const account = await tx.accountOfCustomer(customer.id);
        await tx.publish(
          {
            type: 'suitability.assessed',
            payload: {
              customerId: customer.id,
              ...(account ? { accountId: account.id } : {}),
              profile: assessment.profile,
              score: points,
              validUntil: assessment.validUntil.toString(),
              questionnaireVersion: q.version,
            },
          },
          customer.id,
        );
      } else {
        await this.onboarding.completeStep(tx, caller.userId, 'SUITABILITY');
      }
      return {
        profile: assessment.profile,
        score: points,
        validUntil: assessment.validUntil.toString(),
      };
    });
  }

  /** Rotina diária: aviso 30 dias antes e vencimento (RN-SUI-012). */
  async notifyExpirations(today: BusinessDate): Promise<{ expiring: number; expired: number }> {
    const counts = { expiring: 0, expired: 0 };
    for (const kind of ['EXPIRED', 'EXPIRING'] as const) {
      const until = kind === 'EXPIRING' ? today.plusDays(SUITABILITY_WARNING_DAYS) : today;
      await this.d.store.transaction(async (tx) => {
        for (const a of await tx.assessmentsToNotify(kind, until, 500)) {
          const customer = await tx.customerOfUser(a.userId);
          await tx.markAssessmentNotified(a.id, kind);
          if (!customer) continue;
          await tx.publish(
            {
              type: kind === 'EXPIRED' ? 'suitability.expired' : 'suitability.expiring',
              payload: { customerId: customer.id, validUntil: a.validUntil.toString() },
            },
            customer.id,
          );
          counts[kind === 'EXPIRED' ? 'expired' : 'expiring']++;
        }
      });
    }
    return counts;
  }

  // ---------------------------------------------------------------- termos

  async pending(userId: string) {
    return this.d.store.transaction(async (tx) => {
      const accepted = await tx.acceptedTermsIds(userId);
      return (await tx.currentTerms())
        .filter((t) => !accepted.has(t.id))
        .map((t) => ({
          termsId: t.id,
          code: t.code,
          version: t.version,
          title: t.title,
          content: t.content,
          mandatory: t.mandatory,
          moment: t.moment,
        }));
    });
  }

  /** Aceite com `terms_id`, versão, instante, IP, user agent, canal e hash do conteúdo (RN-TER-002). */
  async accept(caller: Caller, termsId: string, version: number): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const terms = await tx.terms(termsId);
      if (!terms) throw notFound('Termo inexistente.');
      const latest = await tx.latestTermsVersion(terms.code);
      if (terms.version !== version || latest?.id !== terms.id)
        throw new CustomerError(
          409,
          'TERMS_VERSION_OUTDATED',
          `A versão vigente de ${terms.code} é a ${latest?.version}.`,
        );
      const now = this.d.clock.now();
      const inserted = await tx.insertAcceptance({
        id: this.d.newId(),
        userId: caller.userId,
        termsId,
        acceptedAt: now,
        ip: caller.ip ?? null,
        userAgent: caller.userAgent ?? null,
        channel: caller.channel,
        contentHash: terms.contentHash,
      });
      if (!inserted) return;
      await tx.publish(
        {
          type: 'terms.accepted',
          payload: {
            userId: caller.userId,
            termsCode: terms.code,
            version: terms.version,
            acceptedAt: now.toString(),
          },
        },
        caller.userId,
      );
      if ((await this.pendingMandatory(tx, caller.userId)).length === 0) {
        await this.onboarding.completeStep(tx, caller.userId, 'TERMS');
      }
    });
  }

  /**
   * Nova versão de um termo (BO_ADMIN). Se for obrigatório, quem aceitou a anterior fica só com
   * consulta até aceitar a nova (RN-TER-001): o `TERMS_PENDING` da elegibilidade.
   */
  async publishVersion(
    code: string,
    input: { title: string; content: string },
  ): Promise<{ termsId: string; version: number }> {
    return this.d.store.transaction(async (tx) => {
      const latest = await tx.latestTermsVersion(code);
      if (!latest) throw notFound('Termo inexistente.');
      const terms: TermsRow = {
        ...latest,
        id: this.d.newId(),
        version: latest.version + 1,
        title: input.title,
        content: input.content,
        contentHash: createHash('sha256').update(input.content).digest('hex'),
        validFrom: this.d.clock.now(),
      };
      await tx.insertTerms(terms);
      return { termsId: terms.id, version: terms.version };
    });
  }

  /** Termos obrigatórios da abertura sem aceite da versão vigente. */
  async pendingMandatory(tx: CustomerTx, userId: string): Promise<string[]> {
    const accepted = await tx.acceptedTermsIds(userId);
    return (await tx.currentTerms())
      .filter((t) => t.mandatory && t.moment === 'ONBOARDING' && !accepted.has(t.id))
      .map((t) => t.code);
  }
}

export const termsPendingError = (codes: string[]) =>
  rule('TERMS_PENDING', 'Aceite a nova versão dos termos para continuar operando.', {
    terms: codes,
  });
