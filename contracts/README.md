# contracts

Registro de esquemas do broker (D8, RN-MSG-B-020..023, RN-BE-080/081). O esquema é escrito
uma vez em TypeBox e daqui saem o JSON Schema, o AsyncAPI 3 e o OpenAPI 3.1.

```
contracts/
  events/<eventType>/v<N>.ts   # um arquivo por versão de evento (default: defineEventContract)
  http/<serviço>.ts            # rotas do serviço (default: defineHttpContract)
  generated/                   # NÃO editar: saída de `pnpm contracts:generate`, versionada no git
    events/<eventType>/v<N>.schema.json
    asyncapi.json
    openapi/<serviço>.json
```

## Fluxo

1. Crie ou altere o contrato em `events/` ou `http/`.
2. `pnpm contracts:generate` e faça commit de `generated/` junto.
3. `pnpm contracts:check` (o CI roda): reprova se `generated/` estiver desatualizado ou se um
   esquema de evento mudou de forma incompatível em relação ao `main`.

O serviço importa a definição do contrato, nunca a redeclara:

```ts
import { ExamplePingedV1 } from '@broker/contracts/events/example.pinged/v1';
await publisher.publish(trx, ExamplePingedV1, { pingId }, context);
```

## Compatibilidade (RN-MSG-B-021)

Na mesma versão, só é permitido **adicionar campo opcional**. Remover campo, mudar tipo,
formato, restrição ou obrigatoriedade exige criar `v<N+1>.ts` ao lado da versão atual. O
produtor publica as duas por pelo menos 30 dias. Depois disso, a versão antiga sai com
`pnpm contracts:check --allow-removed "<eventType> v<N>"`.

Opções do check: `--base <ref>` (padrão `main`, ou `CONTRACTS_BASE_REF`) e `--repo <dir>`.
