import { Instant } from '@broker/domain-kernel';
import type { ChangeRequest } from '../domain/change-request.js';
import {
  DEFAULT_TRADING_RULES,
  effectiveRules,
  planNewVersion,
  validateRules,
  activeAt,
  type TradingRulesValues,
  type TradingRuleVersion,
} from '../domain/trading-rules.js';
import type { ChangeExecutor, ChangeRequests } from './change-requests.js';
import { requestView } from './change-requests.js';
import { notFound, type Operator, type ReferenceDeps } from './context.js';
import type { ReferenceTx } from './ports.js';

const GLOBAL = 'GLOBAL';

const versionView = (v: TradingRuleVersion) => ({
  id: v.id,
  instrumentId: v.instrumentId,
  rules: v.values,
  validFrom: v.validFrom.toString(),
  validTo: v.validTo?.toString() ?? null,
  approvalRequestId: v.approvalRequestId,
});

/**
 * Parâmetros de negociação com vigência (Ativos §7, RNF-070): padrão global + sobrescrita por
 * instrumento, mudança só por aprovação e `instrument.trading_rules_changed` na execução.
 */
export class TradingRules implements ChangeExecutor {
  constructor(
    private readonly d: ReferenceDeps,
    private readonly requests: ChangeRequests,
  ) {
    requests.register(['TRADING_RULES'], this);
  }

  /** Regras vigentes no instante (padrão: agora) para o instrumento ou só o global. */
  async effective(instrumentId: string | null, at?: Instant) {
    return this.d.store.transaction(async (tx) => {
      if (instrumentId && !(await tx.instrument(instrumentId)))
        throw notFound('Instrumento inexistente.');
      const when = at ?? this.d.clock.now();
      const e = effectiveRules(
        await tx.ruleVersions(null),
        instrumentId ? await tx.ruleVersions(instrumentId) : [],
        when,
      );
      return { instrumentId, at: when.toString(), ...e };
    });
  }

  async versions(instrumentId: string | null) {
    return this.d.store.transaction(async (tx) =>
      (await tx.ruleVersions(instrumentId)).map(versionView),
    );
  }

  async request(
    op: Operator,
    input: {
      instrumentId: string | null;
      rules: Partial<TradingRulesValues>;
      validFrom: string;
      justification: string;
    },
  ) {
    return this.d.store.transaction(async (tx) => {
      if (input.instrumentId && !(await tx.instrument(input.instrumentId)))
        throw notFound('Instrumento inexistente.');
      await this.validate(tx, input.instrumentId, input.rules, Instant.parse(input.validFrom));
      const r = await this.requests.create(tx, op, {
        type: 'TRADING_RULES',
        targetId: input.instrumentId ?? GLOBAL,
        payload: {
          instrumentId: input.instrumentId,
          rules: input.rules,
          validFrom: input.validFrom,
        },
        justification: input.justification,
      });
      return requestView(r);
    });
  }

  /** Estado = a última vigência do escopo; outra aprovada no meio invalida (RN-MC-BO-003). */
  async currentState(tx: ReferenceTx, r: Pick<ChangeRequest, 'targetId'>) {
    const versions = await tx.ruleVersions(r.targetId === GLOBAL ? null : r.targetId);
    const latest = versions.reduce<TradingRuleVersion | null>(
      (acc, v) => (acc === null || v.validFrom.isAfter(acc.validFrom) ? v : acc),
      null,
    );
    return { latestRuleId: latest?.id ?? null };
  }

  async execute(tx: ReferenceTx, r: ChangeRequest): Promise<void> {
    const p = r.payload as {
      instrumentId: string | null;
      rules: Partial<TradingRulesValues>;
      validFrom: string;
    };
    await tx.lockRules(p.instrumentId);
    const validFrom = Instant.parse(p.validFrom);
    const close = await this.validate(tx, p.instrumentId, p.rules, validFrom);
    if (close) await tx.closeRuleVersion(close.id, validFrom);
    const id = this.d.newId();
    await tx.insertRuleVersion({
      id,
      instrumentId: p.instrumentId,
      values: p.rules,
      validFrom,
      validTo: null,
      approvalRequestId: r.id,
    });
    await tx.publish(
      {
        type: 'instrument.trading_rules_changed',
        payload: {
          ruleId: id,
          instrumentId: p.instrumentId,
          rules: p.rules,
          validFrom: p.validFrom,
          approvalRequestId: r.id,
        },
      },
      p.instrumentId ?? 'global',
    );
  }

  /** Valida os valores contra o global vigente em `validFrom` e o encaixe da vigência. */
  private async validate(
    tx: ReferenceTx,
    instrumentId: string | null,
    rules: Partial<TradingRulesValues>,
    validFrom: Instant,
  ) {
    const global = await tx.ruleVersions(null);
    const base = { ...DEFAULT_TRADING_RULES, ...activeAt(global, validFrom)?.values };
    validateRules(rules, instrumentId ? 'INSTRUMENT' : 'GLOBAL', base);
    const scope = instrumentId ? await tx.ruleVersions(instrumentId) : global;
    return planNewVersion(scope, validFrom, this.d.clock.now()).close;
  }
}
