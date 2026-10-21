# Fase 0, grupo 7 — Contratos, cenários e testes compartilhados

> Tarefas 7.1 a 7.3 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/event-messaging/spec.md` (Esquemas versionados). Design: D8 (contratos) e D20 (testes). Regras: `broker-docs/docs/06-mensageria/01-diretrizes.md` (RN-MSG-B-020..023) e `10-qualidade/01-estrategia-de-testes.md` (RN-QA-_).

## Visão geral

Os grupos 3 a 6 criaram o código que todo serviço usa. O grupo 7 cria o que todo **teste** e todo **contrato** usam:

| Peça                                | Onde                         | Tarefa |
| ----------------------------------- | ---------------------------- | ------ |
| registro de esquemas e geração      | `contracts/`                 | 7.1    |
| verificação de compatibilidade      | `contracts/src/compat.ts`    | 7.1    |
| builders, relógio de teste, E2E     | `packages/testing`           | 7.2    |
| teste de integração de referência   | `apps/example-service/test/` | 7.2    |
| formato YAML e runner golden master | `scenarios/`                 | 7.3    |

## 7.1 — Contratos

### Um esquema, três saídas

O esquema é escrito **uma vez**, em TypeBox, e dele saem:

```
contracts/events/example.pinged/v1.ts   ──►  generated/events/example.pinged/v1.schema.json  (JSON Schema 2020-12)
                                        ──►  generated/asyncapi.json                         (AsyncAPI 3)
contracts/http/example-service.ts       ──►  generated/openapi/example-service.json          (OpenAPI 3.1)
```

O TypeBox já produz JSON Schema: `Type.Object({ pingId: Type.String({ format: 'uuid' }) })` **é** um objeto `{ type: 'object', properties: ..., required: [...] }`. A "geração" é só serializar (o `JSON.stringify` descarta os símbolos internos do TypeBox) e acrescentar metadados (`$id`, produtor, auditável).

O mesmo objeto TypeBox é usado em três lugares: o produtor valida o payload antes da outbox, o consumidor valida ao receber e o gerador documenta. Não há como o documento divergir do código, porque não existe uma segunda cópia. Por isso o `example-service` deixou de declarar o `example.pinged` e passou a importar o contrato:

```ts
import { ExamplePingedV1 as Pinged } from '@broker/contracts/events/example.pinged/v1';
import { exampleServiceHttp } from '@broker/contracts/http/example-service';
// ...
validate: { params: exampleServiceHttp.routes.getPing.params },
```

### O caminho não pode mentir

`loadRegistry` descobre os contratos varrendo as pastas e confere que `events/<eventType>/v<N>.ts` define mesmo aquele `eventType` naquela versão. Um `v2.ts` copiado de `v1.ts` sem mudar o número falha na carga, antes de gerar qualquer coisa.

### AsyncAPI: canais e mensagens

No AsyncAPI 3, **canal** é onde as mensagens passam e **operação** é quem faz o quê. O mapeamento para o nosso barramento:

| AsyncAPI        | broker-node                                                             |
| --------------- | ----------------------------------------------------------------------- |
| canal           | super stream do contexto: `{environment}.example.events` (RN-MSG-B-001) |
| mensagem        | uma versão de evento: envelope padrão + payload da versão               |
| operação `send` | o produtor declarado no contrato                                        |

A mensagem é um `allOf` do `Envelope` (o mesmo `EnvelopeSchema` do `@broker/messaging`) com `eventType`/`eventVersion` fixos e o payload da versão. Assim o documento mostra a mensagem como ela realmente trafega.

### Compatibilidade: o que é "quebrar"

A regra RN-MSG-B-021 diz que só **adicionar campo opcional** é compatível. O `compareSchemas` percorre os dois esquemas (objetos e itens de array, recursivamente) e reporta:

- campo removido (obrigatório ou opcional);
- mudança na obrigatoriedade (nos dois sentidos);
- campo obrigatório novo;
- mudança em `type`, `format`, `const`, `enum`, restrições (`pattern`, `minLength`, `maximum`…) ou composições (`anyOf`…).

A regra é conservadora de propósito. Durante a migração, o produtor publica v1 e v2 e consumidores antigos e novos convivem, então a mudança precisa ser segura nas duas direções. Exemplo: acrescentar um valor a um `enum` parece inofensivo, mas um consumidor antigo que faz `switch` sobre o enum recebe um valor que não conhece.

A quebra **em uma versão nova** é permitida: v2 pode ser qualquer coisa. O check só compara a mesma `(eventType, versão)` entre o `main` e a branch.

### O check contra o `main`

```
pnpm contracts:check [--base main]
  1. gera tudo em memória e compara com contracts/generated/ em disco  → "rode pnpm contracts:generate"
  2. lê contracts/generated/events/** do main com `git ls-tree` + `git show`
  3. compara cada versão que já existia no main                        → "crie v2"
```

Por que versionar `generated/` no git? Para comparar com o `main` sem precisar fazer checkout nem rodar código antigo: basta ler os JSON do commit com `git show main:caminho`. O passo 1 garante que o que está em `generated/` corresponde mesmo ao código.

Remover uma versão também reprova (o produtor precisa publicar as duas por 30 dias). Passado o prazo, a remoção é explícita: `--allow-removed "example.pinged v1"`.

A verificação pedida pela tarefa está em `contracts/test/check-cli.test.ts`. O teste monta um repositório git descartável cujo `main` tem o `example.pinged v1` com um campo obrigatório `source` a mais e roda a CLI de verdade:

```
contratos reprovados (base: main):
  - example.pinged v1: payload.source: campo obrigatório removido — crie v2
```

## 7.2 — `@broker/testing`

### Builders (RN-QA-020)

Um builder devolve um objeto **válido** por padrão; o teste sobrescreve só o que importa para a regra:

```ts
const anOrder = defineBuilder<Order>(({ seq, random }) => ({
  id: `order-${seq}`,
  side: 'BUY',
  quantity: random.int(1, 10) * 100,
}));

anOrder({ side: 'SELL' }); // só o lado importa neste teste
anOrder.many(3);
anOrder.reset(); // volta contador e semente
```

O contador e o PRNG semeado tornam os padrões **determinísticos** (RN-QA-002): a mesma sequência de chamadas produz os mesmos objetos, em qualquer máquina e em qualquer ordem de execução, desde que cada teste chame `reset`.

Na Fase 0 ainda não existem agregados (ordem, conta, lançamento), então o pacote traz o `defineBuilder` e os builders do que é compartilhado: `aMoney`, `aTaxId(dígitoKyc)`, `anActor` e `anEnvelope`. Os builders de agregado nascem com cada serviço, em `<svc>/test/builders.ts`.

O `anEnvelope` repete o formato do envelope em vez de importar `@broker/messaging`. O motivo é que `messaging`, `persistence` e `service-kit` têm `@broker/testing` como devDependency; se o `testing` dependesse deles, o Turborepo acusaria um ciclo no grafo de build.

### Relógio de teste

`testClock()` é um `VirtualClock` que começa numa segunda-feira útil às 10:00 de São Paulo. Também aceita uma data de negócio com hora local, sem fazer conta de fuso no teste:

```ts
testClock({ date: '2026-02-18', time: '13:00' }); // Quarta de Cinzas, 13:00 BRT = 16:00Z
```

### Utilitários de E2E

- `apiClient(baseUrl)`: `fetch` com `X-Correlation-Id` novo por chamada (devolvido em `res.correlationId`, para achar logs e traces do fluxo), token opcional e `idempotencyKey: true | 'chave'`.
- `assertProblem(res, 409, 'IDEMPOTENCY_KEY_REUSED')`: confere o Problem Details.
- `waitUntil(cond)` e `eventually(() => expect(...))`: em E2E os efeitos são eventualmente consistentes, então o teste espera o efeito acontecer em vez de usar um `sleep` fixo.

### O teste de integração de referência

`apps/example-service/test/integration/ping-outbox.test.ts` é o modelo para os serviços novos: Postgres real (Testcontainers, com o mesmo script de init do ambiente local), migrações do serviço aplicadas com o usuário `migrator`, conexão com o usuário `app`, relógio virtual e builders. Ele verifica que:

1. o evento vai para a outbox com o `occurred_at` do relógio virtual (RN-CLK-004);
2. um erro depois do `publish` desfaz o ping e o evento juntos (ADR-0008).

`databaseConfig(pg, 'example', 'app')` monta as credenciais de um papel a partir do contêiner.

## 7.3 — Cenários (golden master)

### Por que YAML e não testes em TypeScript

A estratégia de testes pede cenários **independentes de tecnologia**: uma segunda implementação do broker, em Go ou Java, roda os mesmos arquivos. O YAML guarda só dados (entradas e saídas); quem traduz para chamadas de código é o **adaptador** de cada linguagem.

```
scenarios/fee/FEE-010.yaml ──► runner ──► adaptador FEE ──► allocate() do domain-kernel
                                  │                              │
                                  │◄──────── saídas ─────────────┘
                                  └─► diff(saidas_esperadas, saídas)
```

### Formato

```yaml
cenario: FEE-010 rateio com resíduo de centavos
regras: [RN-FEE-031]
semente: 42 # opcional
relogio: '2026-01-05T13:00:00Z' # opcional
entradas:
  operacao: rateio
  total: '0.10'
  itens: [...]
saidas_esperadas:
  partes: { ... }
```

Três decisões:

- **O prefixo do ID escolhe o domínio.** `FEE-010` vai para o adaptador `FEE`. Não existe um campo `dominio` para manter em sincronia com o ID.
- **Decimais entre aspas.** Em YAML, `0.10` vira o número binário 0.1. O `Money.of` recusa `number` (ADR-0004), então um cenário escrito sem aspas falha alto em vez de calcular errado em silêncio.
- **Chave desconhecida é erro.** Um `entrada:` digitado errado seria ignorado e o cenário passaria sem testar nada.

O runner cria um relógio virtual e um PRNG novos **por cenário**, a partir de `relogio` e `semente`. Assim um cenário não depende de outro, nem da ordem em que rodam (RN-QA-002). Um erro com `code` (o `DomainError`) vira a saída `{ erro: CODE }`, para que rejeições também sejam saídas esperadas.

### Diff legível

A comparação é estrutural e devolve **caminhos**, não um dump de dois objetos:

```
✗ FEE-901 rateio com resultado esperado errado  (FEE-901.yaml)
  partes.b
    esperado: "0.04"
    obtido:   "0.03"
```

Num cenário do Motor com dezenas de negócios, isso aponta direto para `trades[7].qty` em vez de pedir uma comparação visual.

### Os dois cenários iniciais

O `CAL-001` e o `FEE-010` já existiam como testes Vitest nos grupos 3.2 e 3.6. Agora existem também como dados, e são os primeiros a rodar no runner. O cenário que falha de propósito (`FEE-901`) fica em `scenarios/test/fixtures/`, fora da varredura do runner, e é usado só pelo teste que confere o formato do diff.

## Mudanças fora das tarefas

- `example-service` importa o evento e o esquema de rota de `@broker/contracts` (antes declarava localmente) e ganhou `vitest.config.ts` para o teste de integração, que roda no `pnpm test`.
- `.prettierignore` ignora `contracts/generated/`: o Prettier reformatava os JSON e o check acusava "desatualizado". O check compara byte a byte, e quem define o formato é o gerador.
- Scripts na raiz: `pnpm contracts:generate`, `pnpm contracts:check` e `pnpm scenarios`.

## Para experimentar

```bash
pnpm contracts:generate && pnpm contracts:check

# quebre o contrato: remova `pingId` de contracts/events/example.pinged/v1.ts
pnpm contracts:generate && pnpm contracts:check   # reprova contra o main: "crie v2"

pnpm scenarios
# troque um valor em scenarios/fee/FEE-010.yaml e rode de novo para ver o diff
```
