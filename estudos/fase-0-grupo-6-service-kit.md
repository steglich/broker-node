# Fase 0, grupo 6 — Service kit

> Tarefas 6.1 a 6.8 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/service-platform/spec.md`. Regras: `broker-docs/docs/04-backend/01-diretrizes-gerais.md` (RN-BE-_), `02-padroes-de-api.md` (RN-API-_), `07-seguranca/01-autenticacao-e-autorizacao.md` (RN-AUTHZ-_), `08-infraestrutura/03-observabilidade.md` (RN-OBS-_).

## Visão geral

Os grupos anteriores criaram as peças: banco (grupo 4), mensageria (grupo 5), tipos de domínio (grupo 3). O grupo 6 cria o **esqueleto de todo microsserviço**: o pacote `@broker/service-kit`. A ideia é que cada um dos ~25 serviços escreva só o que é dele (domínio, casos de uso, rotas) e receba pronto o que é igual em todos:

| Preocupação                                  | Onde está                                   | Tarefa |
| -------------------------------------------- | ------------------------------------------- | ------ |
| configuração validada e segredos             | `config.ts`                                 | 6.1    |
| servidor Express, health, info, encerramento | `service.ts`                                | 6.1    |
| contexto de execução e correlação            | `context.ts`, `service.ts`                  | 6.2    |
| erros RFC 9457 (Problem Details)             | `errors.ts`                                 | 6.2    |
| validação de entrada                         | `validation.ts`                             | 6.2    |
| idempotência e concorrência otimista         | `idempotency.ts`, `concurrency.ts`          | 6.3    |
| logs JSON com mascaramento                   | `logger.ts`                                 | 6.4    |
| traces e métricas (OpenTelemetry)            | `telemetry.ts`, `register.ts`, `metrics.ts` | 6.5    |
| autenticação, autorização, RPC               | `auth.ts`, `rpc.ts`                         | 6.6    |
| paginação e sagas                            | `pagination.ts`, `saga.ts`                  | 6.7    |
| feature flags                                | `flags.ts`                                  | 6.8    |

### Como um serviço usa o kit

O `example-service` (`apps/example-service/src/main.ts`) virou o exemplo completo. O formato é sempre este:

```ts
const config = loadConfigOrExit(Config);            // 6.1: valida tudo ou encerra
const logger = createLogger({ ..., clock });         // 6.4
const service = createService({ config, clock, logger, readiness: { database: ... } });

service.route({
  method: 'post',
  path: '/v1/pings',
  auth: 'public',                                    // obrigatório: 'public' ou escopos/papéis
  validate: { body: SchemaTypeBox },                 // 6.2
  idempotent: true,                                  // 6.3 (padrão em POST)
  flag: 'btc_enabled',                               // 6.8 (opcional)
  handler: async (req, ctx) => ({ status: 202, body: { ... } }),
});

service.onShutdown('database', () => db.destroy());  // fechado no encerramento
await service.start();
```

O ponto central de desenho é o **`service.route`**: em vez de cada serviço montar middlewares do Express na mão (e esquecer algum), a rota é **declarada** e o kit aplica tudo na ordem certa:

```
requisição
  → contexto (correlationId, canal, IP, relógio)          [todas as rotas]
  → autenticação (JWT) → autorização (escopos/papéis)     [se auth ≠ 'public']
  → feature flag                                          [se flag]
  → validação (corpo, query, params)                      [se validate]
  → idempotência (Idempotency-Key)                         [se idempotent]
  → handler(req, ctx) → { status, body, headers }
  → resposta JSON  ou  erro → Problem Details
```

O handler **devolve** a resposta em vez de chamar `res.json()`. Isso permite ao kit capturar a resposta para a idempotência e padronizar a serialização.

---

## 6.1 — Bootstrap, configuração e saúde

### Configuração que falha rápido

RN-BE-061: o serviço valida **toda** a configuração ao iniciar e não sobe se algo estiver errado. O pior cenário seria subir com uma configuração ruim e falhar só na primeira requisição que usasse aquele valor, horas depois.

```ts
const Config = Type.Object({
  ...BaseConfigProperties,
  DB_URL: Type.String(),
  API_SECRET: Type.String({ minLength: 8 }),
});
const config = loadConfigOrExit(Config);
```

- O esquema é **TypeBox** (como os eventos do grupo 5) e a validação é **Ajv** com `coerceTypes` (variável de ambiente é sempre texto; `"8080"` vira número) e `useDefaults` (aplica os valores padrão).
- **Segredos por arquivo**: para cada variável `X`, se existir `X_FILE`, o valor vem do arquivo. É o padrão dos Docker secrets (`DB_PASSWORD_FILE=/run/secrets/db_example_app`): a senha nunca aparece em `docker inspect` nem no ambiente do processo.
- **A mensagem de erro nunca mostra valores**: "`DB_URL: obrigatória e ausente`", "`PORT: must be integer`". O valor errado poderia ser um segredo colado no lugar errado.

O teste roda um processo de verdade sem `DB_URL` e com `PORT=abc`, e confere: código de saída 1, as duas variáveis citadas, e nem o segredo nem `abc` no texto.

### Health: liveness × readiness

| Endpoint        | Pergunta que responde            | Quem usa                                               |
| --------------- | -------------------------------- | ------------------------------------------------------ |
| `/health/live`  | "o processo está vivo?"          | o orquestrador, para **reiniciar** um processo travado |
| `/health/ready` | "posso receber tráfego agora?"   | o balanceador, para **mandar ou não** requisições      |
| `/info`         | versão, commit, ambiente, início | suporte e diagnóstico (RN-CICD-020)                    |

A diferença importa: se o banco cair, o serviço deve ficar **não pronto** (para de receber tráfego) mas **vivo** (não adianta reiniciar, o problema é o banco). O Motor de negociação, ao reconstruir o livro a partir do journal, faz `service.setReady(false)` até terminar: `live` = 200, `ready` = 503 com `state: LOADING` (cenário da spec).

### Encerramento gracioso

Ao receber `SIGTERM` (o que o Docker manda num `docker stop`):

1. readiness vira falso (o balanceador para de mandar tráfego);
2. o servidor **para de aceitar** conexões novas;
3. espera as requisições **em andamento** terminarem (até `SHUTDOWN_TIMEOUT_MS`);
4. roda os ganchos `onShutdown` na **ordem inversa** do registro (registra-se banco, depois consumidor; fecha-se consumidor, depois banco, porque o consumidor usa o banco).

O teste dispara uma requisição lenta, pede o encerramento no meio dela e confere: a lenta terminou com 200, uma nova foi recusada, e os ganchos fecharam na ordem `consumer → database`.

---

## 6.2 — Contexto, validação e erros

### Contexto de execução (RN-BE-011)

Todo comando precisa saber **quem** pediu, **de onde**, **quando** e **dentro de qual fluxo**. Passar isso como parâmetro por todas as funções seria inviável. A solução é o **`AsyncLocalStorage`** do Node: um "armazenamento por requisição" que acompanha automaticamente as chamadas assíncronas.

```ts
interface ExecutionContext {
  actor; // usuário, serviço, backoffice ou anônimo
  accountId?; // do token
  correlationId; // do header X-Correlation-Id ou gerado
  causationId?;
  idempotencyKey?;
  channel;
  ip?;
  userAgent?;
  requestedAt; // relógio do AMBIENTE (grupo 3), não da máquina
  scopes;
  roles;
}
```

Qualquer código chamado durante a requisição pode fazer `currentContext()`. É assim que o **logger** coloca o `correlation_id` em todo log sem ninguém passar o valor. O teste da spec: com `X-Correlation-Id: abc`, o valor aparece na resposta, no contexto do caso de uso e no log.

Um `X-Correlation-Id` com caracteres estranhos é ignorado e trocado por um UUID v7, para ninguém injetar texto arbitrário nos logs.

### Problem Details (RFC 9457)

Todo erro da API sai no mesmo formato, `application/problem+json`:

```json
{
  "type": "https://docs.corretora-estudo.local/errors/insufficient-buying-power",
  "title": "Poder de compra insuficiente.",
  "status": 422,
  "code": "INSUFFICIENT_BUYING_POWER",
  "instance": "/v1/orders",
  "correlationId": "corr-422",
  "context": { "required": { "amount": "3851.15", "currency": "BRL" } }
}
```

| Situação                         | Status | `code`                                       |
| -------------------------------- | ------ | -------------------------------------------- |
| corpo fora do esquema            | 400    | `VALIDATION_ERROR` + `errors[]`              |
| JSON malformado                  | 400    | `MALFORMED_JSON`                             |
| sem token / token inválido       | 401    | `UNAUTHENTICATED`                            |
| sem permissão                    | 403    | `INSUFFICIENT_SCOPE`, `FORBIDDEN`            |
| inexistente **ou de outro dono** | 404    | `NOT_FOUND`                                  |
| conflito                         | 409    | `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` |
| regra de negócio                 | 422    | o código do domínio                          |
| dependência fora                 | 503    | `SERVICE_UNAVAILABLE`                        |
| bug                              | 500    | `INTERNAL_ERROR`                             |

O ponto mais importante é a **conversão de erros técnicos** (RN-BE-031). Se o banco cai, a mensagem do driver é algo como `connect ECONNREFUSED 127.0.0.1:5432`: isso vaza a topologia interna. `isDependencyUnavailable` reconhece esses erros (códigos de rede como `ECONNREFUSED`, SQLSTATE da classe `08` de conexão, erros do `undici`, disjuntor aberto) e devolve `503 SERVICE_UNAVAILABLE` com `Retry-After`. Um erro desconhecido vira `500 INTERNAL_ERROR` com uma frase genérica. Em ambos, o detalhe técnico vai para o **log** com o mesmo `correlationId`, e é assim que o suporte encontra o problema a partir do que o cliente reportou.

O teste usa um banco de verdade numa porta fechada e confere que nem `ECONNREFUSED`, nem o IP, nem um stack aparecem na resposta.

Também: `DomainError` do grupo 3 (ex.: somar BRL com USD) vira 422 com o código do domínio automaticamente.

### Validação

`validate: { body, query, params }` com esquemas TypeBox. Os erros apontam o **campo** e um **código** (RN-BE-020):

```json
"errors": [
  { "field": "symbol",   "code": "INVALID_FORMAT", "message": "must match pattern ..." },
  { "field": "quantity", "code": "MINIMUM",        "message": "must be >= 1" },
  { "field": "price",    "code": "REQUIRED",       "message": "must have required property 'price'" }
]
```

Query e params passam por **coerção** (vêm sempre como texto); o corpo não (JSON já tem tipos, e converter `"10"` em `10` esconderia um cliente mal escrito).

---

## 6.3 — Idempotência e concorrência otimista

### O problema da idempotência

O cliente envia um depósito, a rede cai antes da resposta, o app tenta de novo. Sem cuidado, são **dois depósitos**. A solução (RN-PAD §4) é o cliente mandar uma `Idempotency-Key` única por operação:

| Situação                                   | Resposta                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| primeira vez                               | executa e guarda a resposta                                                 |
| mesma chave, mesmo corpo (até 24 h)        | **a mesma resposta**, sem executar de novo, com `Idempotent-Replayed: true` |
| mesma chave, **outro** corpo               | `409 IDEMPOTENCY_KEY_REUSED`                                                |
| mesma chave enquanto a original ainda roda | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`                                       |
| a original falhou com 5xx                  | a chave é liberada: a repetição executa                                     |

### Como funciona

1. Calcula o **hash** do método, caminho e corpo. O corpo é serializado com as chaves **ordenadas**, então `{"a":1,"b":2}` e `{"b":2,"a":1}` são a mesma requisição.
2. **Valkey primeiro** (caminho rápido, D16): se a chave já tem resposta no cache, devolve.
3. **Banco** (fonte da verdade): `INSERT INTO idempotency_record ... ON CONFLICT DO NOTHING`. Quem conseguir inserir **reservou** a chave e executa. Esse INSERT único é o que impede duas execuções simultâneas: o segundo não consegue inserir, lê a linha, vê que ainda não tem resposta e recebe `IN_PROGRESS`.
4. Ao terminar, grava a resposta no banco e no Valkey.

O teste dispara duas requisições **ao mesmo tempo** com a mesma chave: uma recebe 201, a outra 409, e só um depósito existe. Outro teste esvazia o Valkey (`flushall`) e confirma que a repetição continua funcionando pelo banco.

Respostas **4xx de negócio** são guardadas (são a resposta final: "saldo insuficiente" continua sendo a resposta). Respostas **5xx** não: falha técnica não é resposta, e o cliente deve poder tentar de novo.

### Concorrência otimista (RN-BE-041)

Dois operadores abrem a mesma watchlist e salvam. Sem controle, a segunda gravação apaga a primeira sem ninguém perceber (_lost update_). A solução:

- todo agregado mutável tem uma coluna `version`;
- o GET devolve `ETag: "3"`;
- o PUT manda `If-Match: "3"`;
- o UPDATE é `... SET version = version + 1 WHERE id = $1 AND version = 3`. Se outra gravação já mudou a versão, **nenhuma linha** é atualizada → `409 VERSION_CONFLICT`.

"Otimista" porque não trava nada: assume que conflitos são raros e só detecta no fim. Sem `If-Match`, a resposta é `428 Precondition Required`, para o cliente não sobrescrever sem saber o que está sobrescrevendo. Para comandos vindos de eventos (sem usuário para decidir), `retryOnVersionConflict` repete até 3 vezes.

---

## 6.4 — Logs estruturados

Cada linha é um JSON com os campos mínimos de RN-BE-050:

```json
{
  "level": "INFO",
  "timestamp": "2027-01-04T13:00:00.000Z",
  "wall_clock_at": "2026-10-21T23:12:11.577Z",
  "service": "example-service",
  "environment": "local",
  "version": "0.0.1",
  "correlation_id": "abc",
  "trace_id": "fba35...",
  "span_id": "...",
  "event": "order.accepted",
  "message": "ordem aceita",
  "account_id": "acc-1"
}
```

- **Dois relógios** (RN-CLK-004): `timestamp` é o relógio **do ambiente** (no sandbox acelerado, a data virtual); `wall_clock_at` é o relógio real da máquina. Num incidente, o primeiro diz "em que momento do pregão" e o segundo "em que hora de verdade".
- **`correlation_id`, `trace_id` e `span_id`** entram sozinhos (o `mixin` do pino lê o contexto e o span ativo). Do log no Loki se pula para o trace no Tempo.
- **`event`**: um código estável do log (`order.accepted`), para buscar e alertar sem depender do texto da mensagem.

### Mascaramento por nome de campo (RN-BE-051)

Antes de escrever, o objeto é percorrido **em qualquer profundidade** e os campos sensíveis são trocados pelo nome:

| Campos (sem diferenciar `_`, `-` e maiúsculas)                                                             | Saída                         |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `password`, `token`, `refresh_token`, `client_secret`, `Authorization`, `cookie`, `otp`, `document`, `rg`… | `[REDACTED]`                  |
| `cpf`, `taxId`                                                                                             | `***.982.247-**` (se for CPF) |

O teste loga um objeto com senha, token aninhado, `Authorization`, CPF com e sem máscara dentro de uma lista e um RG, e procura cada valor original na linha emitida. Nenhum aparece.

---

## 6.5 — Traces e métricas (OpenTelemetry)

### O que é um trace

Uma requisição do usuário atravessa vários processos. Um **trace** é a árvore de tudo o que aconteceu por causa dela; cada nó é um **span** (uma operação com início, fim e pai). O identificador do trace viaja entre processos no header **W3C `traceparent`**: `00-<trace_id>-<span_id_pai>-01`.

### Instrumentação automática

`register.ts` liga o SDK do OpenTelemetry, que cria spans sozinho para HTTP (entrada e saída), Express, `pg` (cada consulta), `amqplib` e `undici`. O serviço é iniciado assim:

```bash
node --import @broker/service-kit/telemetry dist/main.js
```

O `--import` é necessário porque o projeto é **ESM**: para interceptar `import pg from 'pg'`, a instrumentação precisa registrar um _hook_ de carregamento de módulos (`import-in-the-middle`) **antes** de o código do serviço ser carregado. Sem `OTEL_EXPORTER_OTLP_ENDPOINT`, a telemetria fica desligada.

### O elo que falta: mensagens

A instrumentação automática não sabe que um evento gravado na outbox vai ser processado por um consumidor minutos depois, noutro processo. Esse elo foi feito à mão no `@broker/messaging` (`tracing.ts`):

- o `EventPublisher` grava no envelope o `traceparent` do span ativo (o da requisição HTTP);
- o `EventConsumer` abre o span `process <eventType>` como **filho** desse `traceparent`.

O pacote de mensageria usa só a **API** do OpenTelemetry (`@opentelemetry/api`), que vira no-op sem o SDK. Ele não fica acoplado ao SDK, e os testes do grupo 5 continuam iguais.

### A verificação no Grafana

O `apps/example-service/test/e2e/grafana-trace.e2e.ts` roda o serviço de verdade, com a telemetria, contra o ambiente local:

1. `POST /v1/pings` → o serviço devolve o `X-Trace-Id`;
2. espera o consumidor processar o ping;
3. pergunta ao **Grafana** (que consulta o **Tempo**) pelo trace;
4. confere a cadeia de pais do span do consumidor.

Resultado real:

```
trace fba3564cc36a9b8f3077561151cf5145:
  process example.pinged ← request handler - /v1/pings ← POST /v1/pings   (19 spans)
```

O mesmo teste confere que as métricas `http_server_request_duration_seconds` e `messaging_consumer_messages_total` chegaram ao **Prometheus**. São as métricas **RED** (_Rate, Errors, Duration_: quantas requisições, quantas falharam e quanto demoraram), por rota e por consumidor.

Para ver você mesmo: Grafana em http://localhost:3000 → _Explore_ → datasource _Tempo_ → cole um `X-Trace-Id`.

---

## 6.6 — Autenticação, autorização e RPC

### Autenticação

O `Authenticator` valida o JWT (RFC 7519) com a biblioteca **`jose`**:

- assinatura **ES256** conferida pela **JWKS** do identity-service (as chaves públicas publicadas numa URL);
- `issuer` e `audience` corretos;
- **validade conferida no relógio do ambiente**. O teste avança o relógio virtual 11 minutos e o token de 10 minutos passa a dar 401.

O token vira um `Principal`: o ator (`USER`, `BACKOFFICE` ou `SERVICE`, conforme o `realm`), a conta, os escopos e os papéis.

### Autorização: duas camadas

1. **Na rota** (RN-AUTHZ-001, negar por padrão): `auth` é obrigatório. Sem ele, `service.route` lança erro na hora de registrar. As opções são `{ scopes }` (cliente), `{ roles }` (backoffice) e `{ principal: 'service' }` (só chamadas entre serviços).
2. **No caso de uso** (RN-BE-012): `ownedBy(ordem, ctx.accountId)` confere se o recurso é da conta do usuário. Se não for, responde **404**, igual a um recurso inexistente (RN-AUTHZ-002). Com 403, um atacante descobriria que a ordem `o-2` **existe**; com 404, não aprende nada. O teste compara as duas respostas e confirma que são idênticas.

### Token de serviço

Serviços falam entre si com token próprio, obtido por **client credentials** (OAuth 2.1): o serviço manda `client_id`/`client_secret` e recebe um token com escopos mínimos (ex.: `risk:pretrade`). O `ServiceTokenProvider` guarda o token e só pede outro perto de expirar. Uma rota com `principal: 'service'` recusa um **usuário** mesmo que ele tenha o mesmo escopo.

### Cliente RPC com disjuntor

Chamadas síncronas entre serviços são raras de propósito (só pré-trade e hold de saque, RN-ARQ-001), mas as que existem precisam se proteger (RN-ARQ-002):

| Proteção        | Como                                                                        | Por quê                                                |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Timeout**     | explícito por tentativa (pré-trade: 200 ms)                                 | sem ele, uma dependência lenta trava quem chama        |
| **Bulkhead**    | um pool `undici` por dependência, com limite de conexões                    | uma dependência lenta não consome as conexões de todas |
| **Retentativa** | só em operação idempotente (GET, PUT, DELETE ou POST com `Idempotency-Key`) | repetir um POST comum pode criar duas reservas         |
| **Disjuntor**   | `opossum`                                                                   | parar de bater numa dependência que está fora          |

O **disjuntor** (_circuit breaker_) tem três estados:

```
FECHADO ──(muitas falhas)──► ABERTO ──(espera resetTimeout)──► MEIA-ABERTURA
   ▲                           │ falha na hora, sem chamar          │ deixa 1 chamada passar
   └──────────(deu certo)──────┴────────────────────────────────────┘ (falhou → volta a ABERTO)
```

Aberto, ele falha **imediatamente** com `503 RISK_UNAVAILABLE`, sem esperar o timeout. Isso protege quem chama (responde rápido ao usuário) e quem é chamado (dá fôlego para se recuperar). O teste: dependência lenta (300 ms) com timeout de 100 ms; depois de 3 falhas o disjuntor abre; a chamada seguinte falha em menos de 30 ms **sem chegar à dependência**; a dependência volta; após o reset, a meia-abertura deixa uma passar e fecha.

Respostas **4xx** da dependência são resultado, não indisponibilidade: não contam para abrir o disjuntor (`errorFilter`). Senão, uma sequência de "saldo insuficiente" desligaria a integração.

---

## 6.7 — Paginação e sagas

### Paginação por cursor

Paginação por página (`?page=3`) tem dois problemas em listas que crescem: fica lenta (`OFFSET 10000` lê e descarta 10 mil linhas) e **pula ou repete** itens quando entra um novo no meio. A paginação por **cursor** (RN-API-020) evita os dois:

```sql
WHERE account_id = 'acc-1'
  AND (created_at, id) < ('2026-10-01T13:39:00Z', '0192...')   -- depois do último item visto
ORDER BY created_at DESC, id DESC
LIMIT 51                                                          -- 50 + 1 para saber se há mais
```

- o cursor (`nextCursor`) é **opaco**: base64 de `[valor da ordenação, id]`. O cliente não deve montá-lo;
- o **`id` como desempate** garante ordem estável quando vários itens têm o mesmo `created_at` (o teste cria lançamentos de 3 em 3 no mesmo minuto);
- a comparação de **tupla** `(created_at, id) < (...)` usa o índice composto `(account_id, created_at, id)` (RN-DB-012);
- `limit` padrão 50, máximo 200: acima disso, conforme a rota, usa 200 (`clamp`) ou responde 400 (`reject`).

Um ajuste feito durante a escrita: a primeira versão comparava `created_at::text`. Para datas funciona, mas para valores numéricos a ordem de texto é errada (`'10' < '9'`). A versão final deixa o PostgreSQL converter os parâmetros para os tipos das colunas.

O teste percorre 120 lançamentos em páginas de 50, 50 e 20 e confere 120 ids distintos.

### Sagas orquestradas (RN-PAD-030/031)

Um saque envolve vários passos em sistemas diferentes: reservar o saldo, transferir via PIX, notificar. Não existe uma transação de banco que cubra os três. Uma **saga** é a sequência de passos com o estado gravado entre eles e, se um passo falha de vez, **compensações** que desfazem os anteriores (liberar a reserva).

O `SagaOrchestrator` grava em `saga_instance` o passo atual, os dados e as tentativas **depois de cada passo**. As peças:

- **Lease** (concessão): antes de executar um passo, a saga ganha um prazo (`deadline_at = agora + timeout do passo`). Enquanto o prazo vale, outra instância do serviço não pega a mesma saga. Se o processo morrer, o prazo vence e a saga fica disponível.
- **Retomada**: `resumePending()` (ao iniciar o serviço) continua as sagas com lease vencido, **a partir do passo em que pararam**.
- **Por isso, passos retomáveis precisam ser idempotentes**: o passo interrompido roda de novo. A transferência PIX do exemplo usa o `withdrawalId` como chave no PIX, então repetir não transfere duas vezes.
- **Timeout por passo** (RN-PAD-031): estourou, conta como falha. Passo idempotente é repetido até `maxAttempts`; esgotado, ou se o passo não é idempotente, a saga **compensa** os passos já feitos, na ordem inversa.

O teste mais importante usa um **processo real**: ele inicia a saga, completa a reserva e se mata com `SIGKILL` no meio da transferência. Então:

1. o banco mostra a saga `RUNNING` no passo `transfer_pix`, com a reserva gravada;
2. um orquestrador novo chama `resumePending()` e **não pega** a saga (o lease ainda vale);
3. depois de o lease vencer, `resumePending()` a completa;
4. os efeitos registrados são `reserve_funds, transfer_pix, transfer_pix, notify`: a transferência rodou duas vezes (idempotente) e o resto uma vez cada.

---

## 6.8 — Feature flags

Funcionalidades em construção podem ser **implantadas desligadas** (RN-PAD-072, RN-CICD-014): o código vai para produção, mas só é ligado quando estiver pronto.

- **Por ambiente**: `FEATURE_FLAGS='{"btc_enabled":false}'` na configuração. Flag desconhecida conta como **desligada** (negar por padrão).
- **Por conta**: a tabela `feature_flag_override` sobrescreve para contas específicas, o que serve para pilotos com alguns clientes. A consulta tem cache curto.
- **Na rota**: `flag: 'btc_enabled'`. Desligada, a resposta é `403 FEATURE_UNAVAILABLE`. **Em consumidores e casos de uso**: `flags.assertEnabled('btc_enabled', accountId)`.

O status `403` foi uma decisão (registrada no mapeamento): `503` sugeriria "tente de novo daqui a pouco" e `404` esconderia que a rota existe.

---

## Mudanças fora das tarefas

### `example-service` virou o serviço de referência

O primeiro teste de ponta a ponta do 6.5 usava um serviço de demonstração gravando no banco do `example-service`. Falhou com "corrupted migrations": o banco tinha uma migração (`0001_migration_marker`) que o serviço de demonstração não conhecia. O erro era de desenho: usar o banco de outro serviço viola o "um banco por serviço" (RN-DB-001).

A solução foi transformar o próprio `example-service` num serviço completo sobre o kit: `POST /v1/pings` grava o ping e o evento na outbox, o relay publica, o consumidor marca como processado, com telemetria. Ele roda no Docker (perfil `full`), atrás do Traefik em `https://example.broker.localhost`, e serve de modelo para os serviços da Fase 1.

### Migrações-base fora de ordem

Ao subir o `example-service` com a versão nova das migrações-base, apareceu um problema real: a migração `0000_platform_blocked_key_retry` (grupo 5) ordena **antes** de `0001_migration_marker`, que já tinha sido aplicada. Por padrão o Kysely recusa aplicar uma migração "no passado". Sem correção, **toda** migração nova da plataforma quebraria os serviços já implantados. O migrador agora usa `allowUnorderedMigrations: true`. É seguro porque as migrações da plataforma e as do serviço são independentes; o teste `persistence/test/unordered.test.ts` cobre o caso.

### Bug no `env:up`

Depois de a máquina reiniciar, `pnpm env:up infra` falhava: o `example-service` (perfil `full`, não pedido) tinha saído com código 1 no desligamento, e a espera do script olhava **todos** os contêineres do projeto. Agora ela considera só os serviços do perfil pedido (`docker compose config --services`).

---

## Problemas no caminho

1. **`iovalkey` sem export padrão de tipo**: `import type Redis from 'iovalkey'` não funciona como tipo; o certo é o export nomeado `Valkey`.
2. **Spans que "não chegavam"**: no teste em memória, o exportador ficava vazio. O span tinha `traceId` válido, então o SDK funcionava; o `SimpleSpanProcessor` da versão 2.x exporta de forma **assíncrona**. Solução: `forceFlush()` antes de ler.
3. **Banco compartilhado entre arquivos de teste, de novo**: o teste novo de migrações fora de ordem usou o banco `migrations`, o mesmo de outro arquivo. Desta vez a verificação pelo **código de saída** (aprendida no grupo 5) mostrou a falha na hora.
4. **`afterAll` travado**: quando o processo do serviço já tinha morrido, `once('exit')` esperava para sempre. O teste passou a conferir `exitCode` antes.

---

## Para experimentar

Rodar os testes do kit (sobem PostgreSQL e Valkey temporários):

```bash
pnpm exec vitest run --project service-kit
```

Rodar a verificação no Grafana (precisa de `pnpm env:up infra`):

```bash
pnpm test:infra
```

Com o perfil `full` no ar, criar um ping pelo Traefik:

```bash
curl -s --cacert infra/certs/ca/rootCA.pem -X POST -D - https://example.broker.localhost/v1/pings
```

Pegue o `x-trace-id` da resposta e abra no Grafana (http://localhost:3000, usuário `admin`, senha em `infra/secrets/grafana_admin_password`): _Explore_ → _Tempo_ → _TraceQL_ ou busca por ID. Você vê a requisição HTTP, os INSERTs no PostgreSQL e o processamento do consumidor na mesma árvore.

Para ver os logs com o mesmo `trace_id`: _Explore_ → _Loki_, filtro `{service_name="example-service"}`.

Ver um erro de validação:

```bash
curl -s --cacert infra/certs/ca/rootCA.pem https://example.broker.localhost/v1/pings/nao-e-uuid
```

O próximo grupo (7) é o de contratos e testes compartilhados: esquemas de eventos em `contracts/`, geração de JSON Schema/AsyncAPI e OpenAPI, verificação de compatibilidade e o runner de cenários golden master.
