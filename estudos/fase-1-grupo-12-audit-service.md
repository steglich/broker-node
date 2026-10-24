# Fase 1, grupo 12 — audit-service

> Tarefas 12.1 a 12.3 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/audit-trail/spec.md`. Regras: `broker-docs/docs/07-seguranca/03-seguranca-de-aplicacao-e-auditoria.md` (§3, RN-AUD-001..005) e `broker-docs/docs/01-dominio/14-backoffice.md` §7 (RN-AUD-BO-001/002). Design: D4 (append-only) e D16 (bucket `audit-anchors`).

## Visão geral

A trilha de auditoria responde: **quem fez o quê, quando, de onde e com qual justificativa**. Ela também precisa provar que ninguém mudou essa resposta depois. Por isso tem três peças:

1. **Captura**: todo evento marcado `auditable` (e os `audit.*` dos BFFs) vira um registro.
2. **Prova de integridade**: os registros formam uma cadeia de hash, verificada todo dia e ancorada fora do banco.
3. **Acesso controlado**: só a auditoria interna e o administrador leem, e cada leitura também vira registro.

```
<env>.identity.events ─┐
<env>.oms.events ──────┼─▶ audit.trail.<ctx> ─▶ audit_record (seq, prev_hash, hash)
<env>.bff-*.events ────┘                                  │
                                                          ▼  23:30
<env>.scheduler.events ─ routine.triggered ─▶ verifica a cadeia ─▶ MinIO audit-anchors (WORM)
                                                          │
<env>.audit.events ◀── routine.completed / failed ────────┘
```

## 12.1 — Append-only encadeado por hash

### O encadeamento

Cada registro guarda o hash do anterior:

```
hash(n) = SHA-256( hash(n−1) || JSON canônico do registro n )
```

O **JSON canônico** tem as chaves ordenadas em todos os níveis. O `jsonb` do PostgreSQL reordena as chaves ao gravar, e sem a ordenação o hash recalculado na leitura nunca bateria. Os instantes são normalizados para ISO UTC com milissegundos, a precisão que volta do banco. O `seq` entra no conteúdo: trocar dois registros de lugar quebra o hash.

O que cada adulteração produz na verificação:

| Adulteração no banco                   | O que a verificação vê                                 |
| -------------------------------------- | ------------------------------------------------------ |
| Mudar um campo                         | `HASH_MISMATCH` no registro                            |
| Mudar o campo e recalcular o hash dele | `PREV_HASH_MISMATCH` no seguinte                       |
| Apagar um registro do meio             | `SEQ_GAP`                                              |
| Regravar a cadeia inteira, coerente    | Nada na cadeia, mas a âncora do bucket não bate (12.2) |

A última linha mostra por que a cadeia sozinha não basta: quem tem acesso total ao banco pode recalcular tudo desde a gênese. A âncora fora do banco fecha essa porta.

### `seq` contínuo, sem sequence

O `seq` não vem de uma `SEQUENCE` do PostgreSQL, porque um rollback deixa buraco nela, e um buraco é justamente o sinal de registro apagado. O append faz, numa transação:

```sql
SELECT pg_advisory_xact_lock(...);                          -- uma cabeça de cadeia por vez
SELECT seq, hash FROM audit_record ORDER BY seq DESC LIMIT 1;
INSERT INTO audit_record (seq = último + 1, prev_hash = hash do último, ...);
```

A trava serializa os appends dos vários consumidores (um por tópico). Sem ela, dois appends concorrentes encadeariam no mesmo `prev_hash` e a cadeia viraria uma árvore. O teste "appends concorrentes" grava 20 registros em paralelo e verifica a cadeia.

### Duas barreiras contra a mutação

O `makeAppendOnly` do grupo 4 tira `UPDATE`/`DELETE`/`TRUNCATE` do `audit_app` e põe um gatilho que recusa a operação até para o dono da tabela. Os testes mostram as duas barreiras: o `audit_app` recebe `permission denied`, e até o superusuário recebe o erro do gatilho. Para simular o atacante, o teste desliga os gatilhos na sessão (`session_replication_role = replica`), algo que só um superusuário consegue. A verificação pega a adulteração do mesmo jeito.

### Captura: um consumidor genérico

O `EventConsumer` do grupo 5 escolhia o handler pelo `eventType` exato. A trilha precisa de "qualquer evento do tópico". Por isso o consumidor ganhou a chave `'*'`, usada quando o tipo não tem handler próprio (e que não confere versão). Uma linha em `handlerFor`. O filtro `auditable || audit.*` fica no domínio da trilha.

O `event_id` é `UNIQUE` na tabela. Isso cobre a reentrega mesmo fora da inbox (a inbox é por consumidor, e o mesmo evento poderia chegar por dois caminhos).

### Mascaramento (RN-AUD-003)

A regra diz que a trilha registra **que** o dado mudou, não o valor. O cenário da spec é a troca de telefone:

```json
{
  "before": { "phone": "***", "name": "Ana" },
  "after": { "phone": "***", "name": "Ana" },
  "changed_fields": ["phone"]
}
```

O `changed_fields` é calculado **antes** do mascaramento. Depois dele, `***` = `***` e a mudança sumiria.

## 12.2 — Verificação diária e âncora

### Quem dispara

A verificação é uma rotina do agendador (grupo 11), `audit_chain_verify`, às 23:30 dos dias de pregão. A rotina entrou no catálogo e numa migração nova do scheduler (`0003`), como o comentário da `0002` pedia. O audit-service consome `routine.triggered` do tópico do agendador e responde no **próprio** tópico (`<env>.audit.events`). Por isso `ROUTINE_RESULT_CONTEXTS` do agendador passa a ter `audit` no compose.

Os dois serviços consomem o tópico um do outro. Para não depender da ordem de subida, o audit-service garante o tópico do agendador (`ensureSuperStream` é idempotente, com os mesmos parâmetros do dono), e o agendador sobe depois do audit-service (`depends_on: service_healthy`).

### O que a rotina faz

1. Se a data já tem âncora, responde `routine.completed` de novo e para (idempotência por data, RN-ROT-001).
2. Recalcula a cadeia inteira, em lotes de 1000.
3. Confere a última âncora: lê o objeto no bucket e compara com o registro daquele `seq`.
4. Grava `audit-anchors/<env>/<data>.json` com `{ seq, hash }` do último registro verificado.
5. Grava `audit_anchor` e `audit_verification` e publica `routine.completed`, tudo na mesma transação da outbox.

Quebra em 2 ou 3: `audit_verification` com `BROKEN`, `routine.failed` e alerta crítico (log `fatal` com `severity: critical`). Nesse caso não sai âncora: ancorar uma cadeia quebrada seria carimbar a adulteração.

### Por que a âncora não pode ser sobrescrita

Há duas camadas, uma de cada lado:

- **No bucket** (grupo 2): object lock em modo `COMPLIANCE`. Nenhuma versão gravada pode ser apagada ou alterada antes do fim da retenção, nem pelo usuário raiz. Um PUT na mesma chave cria **outra versão**, e a original continua lá. O teste confere a versão original e a recusa do `DELETE` (`WORM protected`).
- **Na aplicação**: o PUT é condicional (`If-None-Match: *`), então a chave do dia só é escrita uma vez. Se ela já existir com o mesmo conteúdo, é uma re-execução (o serviço caiu entre gravar no bucket e fazer o commit). Com conteúdo diferente, é conflito. O serviço ainda aceita a âncora existente se ela for um elo verdadeiro da cadeia, e senão alerta `ANCHOR_MISMATCH`.

O corpo da âncora não tem horário, só ambiente, data, `seq` e hash. Assim a re-execução produz exatamente os mesmos bytes.

### A âncora é do "último registro verificado"

A spec fala em "hash do último registro do dia". Os registros chegam em ordem de chegada (`seq`), e não em ordem de `occurred_at`: um evento atrasado de ontem pode chegar hoje. A âncora da data D é então o último registro **até a rotina de D rodar**. Os registros do fim de semana entram na âncora de segunda. A cadeia é contínua, então nada fica de fora.

## 12.3 — Consulta restrita e auditada

`GET /v1/audit-records` é a primeira rota do projeto com **papel** na política (`auth: { roles: ['BO_AUDITOR', 'BO_ADMIN'] }`). O `service-kit` do grupo 6 já validava o JWT pela JWKS e aplicava a política. `BO_FINANCE` recebe `403 FORBIDDEN`, e sem token a resposta é `401`.

A consulta grava o registro `audit.records_queried` (ator, papéis, IP, user-agent, correlação e filtros) **antes** de ler. Se a gravação falhar, nada é devolvido: não existe consulta sem rastro. O período (`from`/`to`) é obrigatório e vai até 1 ano (RN-API-022). A paginação usa cursor sobre o `seq`, do mais novo para o mais antigo.

Os testes geram um par de chaves ES256 e assinam tokens do realm `backoffice`, como o identity-service fará (grupo 13). No compose, `AUTH_JWKS_URL` e `AUTH_ISSUER` já apontam para onde o identity-service vai estar.

## O que ficou de fora

- **Retenção de 5 anos e arquivamento frio** (requisito "Retenção da trilha"): é da Fase 7, grupo 44 (LGPD e retenção). As tabelas nascem com índice em `occurred_at`, compatível com o particionamento mensal.
- **Alerta crítico como notificação**: hoje é log `fatal` mais o callback `onCriticalAlert`. O roteamento para o backoffice fica com o notification-service (grupo 18) e os alertas versionados (Fase 7).
- **Credencial própria no MinIO**: o serviço usa o usuário raiz do MinIO, como os testes de infraestrutura. Um usuário com permissão só de `PutObject`/`GetObject` em `audit-anchors` é o passo natural quando outros serviços passarem a usar o storage.
- **Verificação incremental**: a rotina recalcula a cadeia inteira todo dia. É O(n) e simples. Com volume real, a verificação começaria da última âncora conferida.

## Problemas no caminho

- **`count(*)` é `bigint`**: o teste do barramento esperava `'2'` e o driver devolve `2n` (os `typeParsers` do grupo 4). A espera não terminava nunca.
- **O conteúdo canônico pegava os hashes**: a primeira versão serializava o registro inteiro, inclusive `prev_hash` e `hash`, e o hash recalculado nunca batia. Agora `canonicalContent` usa uma lista explícita de campos.

## Para experimentar

```bash
pnpm env:up core
# as âncoras gravadas, com as versões (o object lock aparece em `mc retention info`)
docker compose -f infra/compose/compose.yml exec minio sh -c \
  'mc alias set l http://localhost:9000 broker "$(cat /run/secrets/minio_root_password)" >/dev/null && mc ls --versions l/audit-anchors/local/'
```
