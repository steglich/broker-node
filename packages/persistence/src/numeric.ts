import { Decimal } from '@broker/domain-kernel';
import {
  OperationNodeTransformer,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type PrimitiveValueListNode,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
  type ValueNode,
} from 'kysely';
import pg from 'pg';

/** OIDs dos tipos do PostgreSQL convertidos na leitura. */
const PG_INT8 = 20;
const PG_NUMERIC = 1700;

/**
 * Leitura (banco → domínio): `numeric` chega como string no driver `pg` e vira `Decimal`
 * (ADR-0004: nunca ponto flutuante); `bigint` (int8) vira `bigint` do JavaScript, sem perder
 * precisão acima de 2^53 (quantidades, RN-DB §3).
 */
export const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === PG_NUMERIC) return (value: string) => new Decimal(value);
    if (oid === PG_INT8) return (value: string) => BigInt(value);
    return pg.types.getTypeParser(oid, format);
  }) as pg.CustomTypesConfig['getTypeParser'],
};

const toParam = (value: unknown): unknown => (value instanceof Decimal ? value.toFixed() : value);

class NumericParamTransformer extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode): ValueNode {
    return super.transformValue({ ...node, value: toParam(node.value) });
  }

  protected override transformPrimitiveValueList(
    node: PrimitiveValueListNode,
  ): PrimitiveValueListNode {
    return super.transformPrimitiveValueList({ ...node, values: node.values.map(toParam) });
  }
}

/**
 * Escrita (domínio → banco): parâmetros `Decimal` viram string decimal exata (`toFixed()`, sem
 * notação científica). Sem isso o driver serializaria o objeto como JSON (`"\"1.5\""`).
 */
export class NumericPlugin implements KyselyPlugin {
  private readonly transformer = new NumericParamTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}
