# Fase 0, grupo 4 — Persistência

> Tarefas 4.1 a 4.4 de `openspec/changes/implementation-roadmap/tasks.md`. Regras: `broker-docs/docs/05-banco-de-dados/01-diretrizes.md` (RN-DB-*), RN-MSG-B-030..036, RN-ENV-021.

## Visão geral

O grupo 2 criou o PostgreSQL com um database e duas credenciais por serviço. O grupo 3 criou os tipos de domínio (`Decimal`, `Money`...). O grupo 4 é a **ponte entre os dois**: a biblioteca `@broker/persistence`, que todo serviço vai usar para falar com o banco.

| Arquivo                  | O que resolve                                                | Tarefa |
| ------------------------ | ------------------------------------------------------------ | ------ |
| `src/config.ts`          | ler `DB_*` e a senha do Docker secret                        | 4.1    |
| `src/database.ts`        | criar o pool `pg` e a instância Kysely                       | 4.1    |
| `src/numeric.ts`         | `numeric` ↔ `Decimal` e `int8` ↔ `bigint`                    | 4.1    |
| `src/transaction.ts`     | transação com commit/rollback e repetição em conflito        | 4.1    |
| `src/migrator.ts`        | aplicar migrações e o ponto de entrada do contêiner one-shot | 4.1    |
| `src/base-migrations.ts` | as 8 tabelas técnicas que todo serviço tem                   | 4.2    |
| `src/append-only.ts`     | transformar uma tabela em "só inserção"                      | 4.2    |
| `src/field-crypto.ts`    | criptografia de campo (CPF etc.) e hash para busca           | 4.3    |
| `src/leader.ts`          | eleição de líder entre instâncias                            | 4.4    |

---

## 4.1 — Kysely, tipos, transações e migrador

### Por que Kysely

Existem três estilos de acesso a banco em Node:

| Estilo                   | Exemplo         | Como é                                                        |
| ------------------------ | --------------- | ------------------------------------------------------------- |
| SQL puro                 | `pg`            | você escreve a string SQL; nenhum tipo                        |
| **Query builder tipado** | **Kysely**      | monta SQL com funções; o TypeScript confere tabelas e colunas |
| ORM                      | Prisma, TypeORM | você mexe em objetos; o ORM gera o SQL                        |

O design (D4) escolheu Kysely porque, num sistema financeiro, é preciso **controlar o SQL exato**: `FOR UPDATE SKIP LOCKED` no relay da outbox, níveis de isolamento, tipos `numeric`. ORMs escondem isso. Ao mesmo tempo, o Kysely dá tipos: `db.selectFrom('account_balance').select('amout')` com erro de digitação não compila.

### A conversão de tipos: o ponto mais importante do grupo

O driver `pg` devolve `numeric` como **string** (`"123.45"`) e `bigint` (int8) também como string. Isso é proposital: converter para `number` perderia precisão. Mas string não é o tipo do domínio. A conversão acontece em dois sentidos:

**Leitura (banco → código)**: o pool recebe `types: typeParsers` (`src/numeric.ts`), que diz ao driver como converter cada tipo pelo seu OID (o número interno que o PostgreSQL usa para identificar tipos):

```ts
if (oid === 1700) return (value) => new Decimal(value); // numeric → Decimal
if (oid === 20) return (value) => BigInt(value); // int8 → bigint
```

Isso é configurado **por pool**, não globalmente: outro código no mesmo processo não é afetado.

**Escrita (código → banco)**: quando você passa um `Decimal` como parâmetro, o `pg` não sabe o que é. Para objetos desconhecidos ele faz `JSON.stringify`, e como `Decimal` tem `toJSON()`, o banco receberia `"\"1.5\""` (com aspas) e falharia. A solução é um **plugin do Kysely** (`NumericPlugin`): antes de a query ir para o driver, ele percorre a árvore da consulta e troca todo `Decimal` por `decimal.toFixed()` (string exata, sem notação científica: `1e-8` vira `"0.00000001"`).

O Kysely representa cada consulta como uma **árvore de nós** (`SelectQueryNode`, `WhereNode`, `ValueNode`...). Um `OperationNodeTransformer` visita essa árvore; o plugin sobrescreve só os nós de valor (`transformValue`, `transformPrimitiveValueList`).

Teste: grava `123456789012345678.12` (18 dígitos antes da vírgula, além do que um `number` representa) e `2^62` como quantidade, e lê de volta idênticos.

### Transações

```ts
await inTransaction(db, async (trx) => {
  await trx.insertInto('ledger_entry')...;
  await trx.insertInto('outbox_event')...;   // efeito + evento: tudo ou nada
});
```

Se a função termina, **commit**; se lança erro, **rollback** e nada fica gravado. É a base do padrão outbox (grupo 5): o lançamento e o evento que o anuncia precisam ser atômicos.

Opções:

- `isolation`: `read committed` (padrão), `repeatable read` ou `serializable`. RN-DB §2 exige impedir _lost update_ no ledger: duas transações leem saldo 100, cada uma debita 30 e grava 70, e um débito some. `serializable` (ou `version` otimista) impede isso.
- `retries`: em `serializable`, o PostgreSQL às vezes aborta uma transação com o código **40001** ("não consegui serializar") ou **40P01** (deadlock). Não é bug: é o banco dizendo "tente de novo". `inTransaction` repete a **transação inteira** só nesses dois códigos; qualquer outro erro sobe direto.

### Migrador

Migração = um arquivo versionado que muda o esquema (`CREATE TABLE`, `ALTER TABLE`). Regras (RN-DB-020/021):

- versionadas e em ordem: o nome dá a ordem (`0000_platform_base`, `0001_account_balance`);
- cada uma roda **uma vez**: o Kysely registra as aplicadas na tabela `schema_migration`;
- só uma instância migra por vez: o Kysely trava `schema_migration_lock`;
- padrão expand/contract: nunca remover ou renomear coluna que a versão em produção usa.

`runMigrationsFromEnv(migrations)` é o ponto de entrada do **contêiner one-shot** do grupo 2: lê `DB_*` e a senha em `DB_PASSWORD_FILE`, aplica, imprime o resultado e devolve o código de saída (0 = ok). O `example-service` passou a usá-lo, e o `pnpm env:up full` mostrou:

```
example-migrate-1  | migração 0000_platform_base: Success
example-migrate-1  | migração 0001_migration_marker: Success
```

Isso também provou que o Dockerfile empacota pacotes do workspace (`@broker/persistence`, `@broker/domain-kernel`) dentro da imagem via `pnpm deploy`.

---

## 4.2 — Tabelas técnicas e append-only

### As tabelas que todo serviço tem

`baseMigrations` cria, numa migração só:

| Tabela               | Para que serve                                                                                       | Regra            |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| `outbox_event`       | eventos a publicar, gravados na mesma transação do efeito; `seq` dá a ordem de inserção para o relay | ADR-0008, D7     |
| `processed_event`    | **inbox**: `(event_id, consumer)` já processados; impede efeito duplicado                            | RN-MSG-B-030     |
| `consumer_offset`    | até onde o consumidor leu cada partição do stream, gravado junto com o efeito                        | D6               |
| `idempotency_record` | resposta guardada por chave de idempotência da API (repetir o POST devolve a mesma resposta)         | RN-API           |
| `saga_instance`      | estado de processos de vários passos (sagas)                                                         | RN-DB §4         |
| `dead_letter`        | mensagens que falharam todas as tentativas (DLQ), com status `PENDING`/`REPROCESSED`/`DISCARDED`     | RN-MSG-B-033/036 |
| `blocked_key`        | chave de partição bloqueada porque uma mensagem dela foi para a DLQ                                  | RN-MSG-B-035     |
| `parked_message`     | mensagens seguintes da chave bloqueada, guardadas em ordem até liberar                               | D6               |

Detalhes que valem estudar:

- **Índice parcial** (`WHERE published_at IS NULL`): indexa só as linhas pendentes da outbox. Depois de publicadas, saem do índice, então ele fica pequeno mesmo com milhões de eventos (RN-DB-011).
- **`GENERATED ALWAYS AS IDENTITY`**: um contador gerado pelo banco. O UUID v7 já ordena por tempo, mas dois processos podem gerar IDs fora da ordem de commit; o `seq` dá a ordem real de inserção.
- **`CHECK (status IN (...))`**: enum como texto com restrição (RN-DB §3: "nunca inteiros mágicos").
- **Datas técnicas com `now()` do banco**: `created_at`, `processed_at`... são carimbos de infraestrutura. Instantes de **negócio** (`occurred_at`) vêm sempre da aplicação, pelo relógio do ambiente: no sandbox acelerado o banco estaria em 2026 e o pregão virtual em outra data.

### Append-only: duas barreiras

Tabelas de fatos (`ledger_entry`, `order_event`, `audit_record`...) **nunca** podem ser alteradas: um lançamento errado se corrige com um **estorno** (novo lançamento), não editando o antigo. É isso que torna o histórico auditável.

`makeAppendOnly(db, 'ledger_entry')`, chamado na migração logo depois do `CREATE TABLE`, cria duas proteções:

1. **Permissão**: `REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entry FROM ledger_app`. O usuário da aplicação simplesmente não tem o direito.
2. **Gatilho**: `forbid_mutation()` roda **antes** de qualquer UPDATE, DELETE (por linha) ou TRUNCATE (por comando) e lança erro. Ele vale até para o dono da tabela (`ledger_migrator`).

Por que duas? **Defesa em profundidade.** Se alguém, numa migração futura, der `GRANT UPDATE` por engano, a primeira barreira cai mas a segunda segura. O teste faz exatamente isso: dá o GRANT, tenta o UPDATE, vê o gatilho recusar e confere que o valor não mudou.

O helper descobre o usuário da aplicação a partir do usuário de migração: `ledger_migrator` → `ledger_app`, seguindo o padrão do script de init.

---

## 4.3 — Criptografia de campo

### O problema

RN-DB-031: CPF, documento, data de nascimento, endereço e telefone ficam **cifrados no banco**, campo a campo. Se o banco vazar (um backup copiado, por exemplo), os dados pessoais não ficam legíveis. Ao mesmo tempo, o sistema precisa **achar um cliente pelo CPF** sem decifrar a tabela inteira.

### AES-256-GCM

É uma **cifra autenticada**: além de esconder o conteúdo, ela gera uma etiqueta (_tag_) que detecta qualquer alteração. Trocar um único bit do valor cifrado faz a decifragem falhar, em vez de devolver lixo.

Cada valor usa um **IV** (vetor de inicialização) aleatório de 12 bytes. Por isso cifrar o mesmo CPF duas vezes dá resultados diferentes, e quem olha o banco não consegue ver que dois clientes têm o mesmo CPF.

O formato gravado é:

```
v1.k1a2b3c4.<base64url( IV | tag | texto cifrado )>
│  └─ ID da chave que cifrou
└─ versão do formato (permite mudar o algoritmo no futuro)
```

### Contexto como AAD

Cada cifragem recebe um "contexto", como `customer.tax_id`, que entra como **dado autenticado adicional** (AAD): não é cifrado, mas faz parte da autenticação. Um valor cifrado do campo `tax_id` copiado para a coluna `phone` não decifra com o contexto `customer.phone`. Isso impede um ataque de "trocar valores entre colunas".

### Envelope encryption

Usar uma chave só para tudo teria dois problemas: ela teria de estar no banco (e vazaria junto) ou em todo lugar; e trocá-la exigiria recifrar tudo. A solução são **duas camadas de chave**:

```
chave-mestra (KEK)  ── Docker secret, nunca vai para o banco
      │ cifra
      ▼
chave de dados (DEK) ── guardada CIFRADA na tabela data_key
      │ cifra
      ▼
CPF do cliente      ── coluna tax_id_encrypted
```

- O banco sozinho é inútil: tem a DEK, mas cifrada pela KEK, que não está lá.
- **Rotação** (`rotateDataKey`): cria uma DEK nova e ativa; as antigas ficam só para decifrar. Como cada valor diz qual chave o cifrou (`k1a2b3c4`), os valores antigos continuam legíveis. Um índice único parcial (`WHERE active`) garante uma chave ativa por vez.
- `loadKeyring` cria a primeira DEK na primeira execução. Duas instâncias subindo juntas poderiam criar duas; um **advisory lock de transação** (`pg_advisory_xact_lock`) faz uma esperar a outra.

### Busca: hash com chave (HMAC)

Para achar por CPF, grava-se ao lado um `tax_id_hash`. Um SHA-256 simples **não serve**: existem só ~10^9 CPFs, e um atacante com o banco calcularia o hash de todos em minutos e reverteria a coluna. Com **HMAC-SHA256**, o hash depende de uma chave secreta própria; sem ela, não dá para testar CPFs.

A busca vira: `WHERE tax_id_hash = hmac(cpf)`, e só a linha encontrada é decifrada.

`matches()` compara com `timingSafeEqual`: uma comparação comum para no primeiro byte diferente, e o tempo de resposta vazaria quantos bytes acertaram.

### Testes

Sem banco: round-trip, IV diferente a cada vez, valor adulterado falha, contexto errado falha, chave-mestra errada não abre a DEK. Com banco: o valor gravado **não contém** o CPF (nem com máscara), a busca pelo hash acha a linha, a DEK é reaproveitada na segunda carga, e depois da rotação o valor antigo ainda decifra.

---

## 4.4 — Eleição de líder

### O problema

Alguns componentes precisam de **um único escritor** (RN-ENV-021): o agendador (senão as rotinas rodam duas vezes), o líder da fila da brapi (senão a cota é gasta em dobro), as partições do Risco e do Motor. Mas para ter alta disponibilidade, roda-se mais de uma instância. Elas precisam combinar **quem manda**, e a outra fica de reserva (_standby_).

O design (D14) não quis um componente extra (como etcd ou ZooKeeper): usa o **próprio PostgreSQL do serviço**.

### Advisory lock de sessão

Um _advisory lock_ é um cadeado identificado por um número, que o PostgreSQL guarda mas não associa a nenhuma tabela: o significado é a aplicação que dá.

```sql
SELECT pg_try_advisory_lock(hashtextextended('scheduler', 0));
--      ↑ tenta, sem esperar       ↑ nome → número de 64 bits
```

- Se ninguém tem o cadeado, devolve `true`: essa instância é a líder.
- Se outra sessão tem, devolve `false` na hora (não bloqueia).
- O cadeado é **da sessão (conexão)**: se o processo morre, o sistema operacional fecha a conexão, o PostgreSQL encerra a sessão e **solta o cadeado sozinho**. Não há como um líder morto segurar a liderança para sempre.

### O `LeaderElector`

- Mantém **uma conexão dedicada** (não do pool: uma conexão do pool poderia ser trocada e o lock ficaria noutra sessão).
- A cada heartbeat (padrão 2 s):
  - se **não é líder**, tenta `pg_try_advisory_lock`;
  - se **é líder**, confere em `pg_locks` que a própria sessão ainda tem o cadeado.
- Se o heartbeat falha ou demora mais que o limite, ele **se declara não-líder** (`onRevoked`), descarta a conexão e volta a disputar no próximo ciclo.
- `stop()` encerra a conexão, o que solta o cadeado na hora.

Detalhe técnico: um lock de 64 bits aparece em `pg_locks` dividido em duas colunas de 32 bits (`classid` = metade alta, `objid` = metade baixa). Para comparar, junta-se de volta: `(classid::bigint << 32) | objid::bigint`.

### O limite conhecido

Entre a queda real da conexão e o próximo heartbeat, o antigo líder ainda **acha** que lidera. Durante esse intervalo, se a rede dele caiu mas o processo segue vivo, podem existir dois "líderes" por alguns instantes. É uma limitação de toda eleição por lease. As saídas:

- escrever sob liderança **no mesmo banco**: se a sessão caiu, a transação também cai;
- usar um **fencing token**: um número que cresce a cada eleição e que o destino confere, recusando ordens de um líder antigo.

Está registrado no mapeamento tecnológico.

### Como foi verificado

1. **Dois processos de verdade**: o teste inicia dois processos Node com o candidato (`test/fixtures/leader-candidate.ts`). Só o primeiro imprime `ELECTED`; o segundo fica em espera por 1 s (vários heartbeats). Então o primeiro é morto com `SIGKILL` (morte abrupta: sem `stop()`, sem soltar o cadeado na mão) e o segundo imprime `ELECTED`.
2. Papéis diferentes (`scheduler` e `brapi-queue`) têm líderes independentes.
3. `stop()` passa a liderança na hora; a ordem dos eventos é `first:elected → first:revoked → second:elected`.
4. Um administrador derruba a sessão do líder no servidor (`pg_terminate_backend`): o líder percebe, chama `onRevoked`, reconecta e, sem concorrente, volta a liderar.

A suíte rodou 3 vezes seguidas com 27/27, para descartar instabilidade de tempo.

---

## Os testes de integração com Testcontainers

**Testcontainers** é uma biblioteca que sobe contêineres Docker de dentro do teste e os destrói no fim. Aqui:

- `test/global-setup.ts` roda **uma vez** antes de todos os arquivos de teste: sobe `postgres:17.11-alpine` e copia para dentro dele o **mesmo script de init do ambiente local** (`infra/postgres/init/01-services.sh`), com um catálogo de teste e senhas aleatórias.
- O resultado (host, porta, senhas) é passado aos testes com `project.provide('postgres', ...)` e lido com `inject('postgres')`.
- Cada arquivo de teste usa **seu próprio database** (`migrations`, `appendonly`, `crypto`, `leader`), para um não interferir no outro.

Vantagem: os testes exercitam as credenciais reais. Se o script de init mudar e quebrar as permissões, estes testes pegam.

Consequência: **`pnpm test` agora precisa do Docker** rodando.

---

## Problemas no caminho

1. **Scripts de instalação bloqueados**: `testcontainers` e `tsx` trouxeram dependências com scripts (`esbuild`, `ssh2`, `cpu-features`, `protobufjs`), todos opcionais. Foram negados em `allowBuilds` no `pnpm-workspace.yaml`, como o `unrs-resolver` no grupo 1.
2. **API do Kysely 0.29**: o `Migrator` e o tipo `Migration` saíram do pacote principal e foram para `kysely/migration`. O erro do TypeScript avisava literalmente: `import from 'kysely/migration' instead`.
3. **`pg_terminate_backend` sem permissão**: o `_migrator` não pode derrubar a sessão de outro usuário. O teste passou a usar o superusuário do contêiner (só no teste; o código de produção nunca usa).
4. **Processos órfãos (o mais instrutivo).** O teste de dois processos falhava: o segundo candidato nunca virava líder, sem nenhum erro. A investigação foi:
   - logs dentro do `tick()` mostraram `acquired: false` desde o primeiro ciclo: alguém já tinha o cadeado;
   - uma consulta direta de teste conseguia o lock, então o problema era do processo filho;
   - `ps` mostrou **3 processos `leader-candidate` vivos** de execuções anteriores.

   A causa: o CLI `tsx` **inicia um segundo processo Node** para rodar o script. O teste matava com `SIGKILL` o processo `tsx` (o pai), e o filho, que tinha a conexão e o cadeado, seguia vivo. O "líder morto" nunca morria, e os órfãos de uma execução atrapalhavam a seguinte. A correção foi rodar o candidato num processo só: `node --import tsx --conditions=source script.ts`.

   Lição: quando o teste diz que "matou o processo", confira **qual** processo morreu.

---

## Pendências e decisões em aberto

- **`pnpm test` exige Docker** (Testcontainers). Se incomodar, dá para separar `test:unit` (sem Docker) e `test:integration`.
- **Limite da eleição por lease** (ver 4.4): fencing token quando algum escritor precisar.
- Os arquivos de teste ainda não passam por typecheck (pendência do grupo 3).

---

## Para experimentar

Rodar só os testes de persistência (sobe um PostgreSQL temporário):

```bash
pnpm exec vitest run --project persistence
```

Ver a outbox e as tabelas técnicas no banco do exemplo (com `pnpm env:up full` rodando):

```bash
PGPASSWORD=$(cat infra/secrets/db/example_app) psql -h localhost -U example_app -d example -c '\dt'
```

Ver as migrações aplicadas:

```bash
PGPASSWORD=$(cat infra/secrets/db/example_app) psql -h localhost -U example_app -d example -c 'SELECT * FROM schema_migration'
```

Ver um advisory lock na prática: abra dois `psql` no mesmo database e rode `SELECT pg_try_advisory_lock(42);` nos dois. O primeiro recebe `t`, o segundo `f`. Feche o primeiro (`\q`) e rode de novo no segundo: agora é `t`.

O próximo grupo (5) é a mensageria: RabbitMQ streams, o envelope dos eventos, o relay da outbox e os consumidores com inbox, retry e DLQ, que vão usar as tabelas criadas aqui.
