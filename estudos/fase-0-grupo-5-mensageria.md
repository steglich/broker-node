# Fase 0, grupo 5 — Mensageria (RabbitMQ streams)

> Tarefas 5.1 a 5.8 de `openspec/changes/implementation-roadmap/tasks.md`. Regras: `broker-docs/docs/06-mensageria/01-diretrizes.md` (RN-MSG-B-*), ADR-0008 (outbox). Decisões: design D6 e D7, e a [ADR-0001 da implementação](../docs/adr/0001-rabbitmq-streams.md).

## Visão geral

Os serviços do broker não chamam uns aos outros diretamente (salvo duas exceções síncronas). Eles conversam por **eventos**: o ledger lança um crédito e publica `ledger.entry_posted`; custódia, risco e notificações reagem. O grupo 5 constrói a biblioteca `@broker/messaging`, que faz essa conversa ser **confiável**:

- nenhum evento se perde, mesmo se um processo cair no pior momento;
- nenhum efeito acontece duas vezes, mesmo se o evento chegar duas vezes;
- eventos da mesma conta são processados na ordem em que aconteceram;
- uma mensagem com problema não derruba o consumidor nem se perde: vai para retentativas e, no fim, para a DLQ, onde um operador decide o que fazer.

O caminho completo de um evento:

```
 serviço produtor                              RabbitMQ                          serviço consumidor
┌──────────────────────────────┐        ┌───────────────────────┐        ┌─────────────────────────────────┐
│ caso de uso (transação)      │        │ super stream          │        │ EventConsumer (SAC/partição)    │
│  ├─ muda o estado            │        │ prod.ledger.events    │        │  transação:                     │
│  └─ EventPublisher ─► outbox │        │  ├─ partição 0        │  ───►  │   ├─ chave bloqueada? estaciona │
│          │ pg_notify         │        │  ├─ partição 1        │        │   ├─ inbox (já processei?)      │
│          ▼                   │ ─────► │  └─ partição 2        │        │   ├─ efeito (handler)           │
│ OutboxRelay                  │publica │                       │        │   └─ offset                     │
│  (marca published_at)        │+confirm│ filas quorum (AMQP):  │ ◄───── │ falhou? retry.1m/10m/1h → DLQ   │
└──────────────────────────────┘        │  retry.*, dlq, jobs   │        └─────────────────────────────────┘
                                        └───────────────────────┘
```

Pacote: `packages/messaging/src`:

| Arquivo                        | Papel                                                            | Tarefa  |
| ------------------------------ | ---------------------------------------------------------------- | ------- |
| `envelope.ts`, `validation.ts` | envelope padrão em TypeBox, validação com Ajv                    | 5.2     |
| `events.ts`, `publisher.ts`    | definição de eventos e o `EventPublisher` (grava na outbox)      | 5.2     |
| `stream/*`                     | conexão, roteamento murmur3, topologia, produtor com confirmação | 5.1/5.3 |
| `relay.ts`                     | `OutboxRelay`: da outbox para o barramento                       | 5.3     |
| `consumer.ts`                  | `EventConsumer`: inbox, offset, retentativas, bloqueio por chave | 5.4–5.6 |
| `amqp.ts`, `serial-queue.ts`   | filas quorum e fila serial por partição                          | 5.4/5.5 |
| `dlq.ts`, `bin/dlq-cli.ts`     | ferramenta de DLQ (API e CLI)                                    | 5.7     |
| `jobs.ts`                      | filas de trabalho                                                | 5.8     |

---

## Conceitos de RabbitMQ necessários

O RabbitMQ tem dois modelos bem diferentes, e o design (D6) usa os dois:

| Modelo           | Como funciona                                                                                                                  | Uso no broker                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| **Stream**       | um **log**: as mensagens ficam guardadas (por idade ou tamanho) e cada consumidor lê a partir de um **offset**. Ler não apaga. | eventos de domínio e comandos |
| **Fila (queue)** | a mensagem é entregue a **um** consumidor e some quando ele confirma (ack)                                                     | retentativas, DLQ e jobs      |

- **Super stream**: um stream dividido em **partições** (`prod.ledger.events-0`, `-1`, `-2`). Cada mensagem vai para uma partição conforme a sua **chave** (ex.: `account_id`). Mesma chave → mesma partição → ordem garantida para aquela chave. Partições diferentes podem ser processadas em paralelo.
- **Offset**: a posição de uma mensagem dentro da partição (0, 1, 2…). O consumidor guarda até onde leu; para **reconstruir** uma projeção, basta ler de novo desde o offset 0 (RN-PAD-041). Uma fila comum não permite isso, e é por isso que eventos usam streams.
- **Single Active Consumer (SAC)**: várias instâncias de um serviço se registram no mesmo grupo, mas só **uma por partição** fica ativa; as outras esperam. Se a ativa cair, o broker promove outra. Isso dá ao mesmo tempo **escala** (partições divididas entre instâncias) e **ordem** (um único leitor por partição).
- **Fila quorum**: fila replicada e durável (a recomendada para dados importantes). Suporta TTL (tempo de vida da mensagem) e _dead-lettering_ (quando a mensagem expira ou é rejeitada, vai para outra fila).

---

## 5.1 — O spike

### Por que um spike

O design apontava como **maior risco** a maturidade do cliente JavaScript de RabbitMQ streams. Antes de escrever a biblioteca, um _spike_ (experimento curto e descartável) responde: "isso funciona do jeito que precisamos?". Se não funcionasse, o plano B era trocar por Redpanda/Kafka.

O spike (`test/spike/rabbitmq-streams.spike.test.ts`) testou contra um RabbitMQ real:

| Verificação                                           | Resultado                   |
| ----------------------------------------------------- | --------------------------- |
| super stream de 3 partições                           | OK                          |
| 2 instâncias: o broker divide as partições entre elas | OK                          |
| ordem por chave (20 chaves × 5 mensagens)             | OK                          |
| failover: A cai, B assume e retoma do offset salvo    | OK, sem perda nem duplicata |
| releitura desde o início e a partir de um offset      | OK                          |
| deduplicação no broker por `publishingId`             | OK                          |

**Decisão: manter RabbitMQ streams**, mas com quatro contornos, documentados na ADR-0001. Os achados são o tipo de coisa que só aparece testando:

1. **`SuperStreamPublisher` sem confirmação.** A classe pronta de publicação não avisa quando o broker gravou a mensagem. O relay **precisa** dessa confirmação antes de marcar o evento como publicado. Contorno: rotear sozinho e usar um publisher por partição, que confirma.
2. **`declareSuperStreamConsumer` sem o callback de offset.** Quando uma instância vira a ativa de uma partição, precisa retomar do offset guardado **no banco do serviço** (porque o offset é gravado na mesma transação do efeito). A classe pronta não aceita esse callback. Contorno: declarar um consumidor SAC por partição, com o callback.
3. **Pool de conexões com socket morto.** Fechar o último consumidor de uma conexão encerra o socket, mas o pool ainda o reaproveita no próximo `declareConsumer`. Achado quando o teste de releitura falhou com "socket has been ended". Contorno: fechar o cliente inteiro.
4. **Entregas sobrepostas.** O cliente espera o handler de cada mensagem dentro de um lote (_chunk_), mas dois lotes podem ser entregues ao mesmo tempo. Contorno: uma **fila serial por partição** no nosso consumidor (`SerialQueue`).

### O roteamento por chave (murmur3)

Para rotear sozinho (achado 1), o produtor calcula a partição como os clientes oficiais fazem: `murmur3_32(chave) mod nº_partições`, com semente 104729. **murmur3** é uma função de hash rápida e bem distribuída (não criptográfica). Um teste compara a nossa implementação com a interna da biblioteca em 509 chaves: se divergissem, o nosso produtor e outro cliente mandariam a mesma conta para partições diferentes e a ordem quebraria.

---

## 5.2 — O envelope e o `EventPublisher`

### O envelope

Toda mensagem tem o mesmo formato (RN-MSG-B §4):

| Campo                           | Para que serve                                                 |
| ------------------------------- | -------------------------------------------------------------- |
| `eventId`                       | UUID v7 único: a base da deduplicação                          |
| `eventType` / `eventVersion`    | o que aconteceu e em qual versão do esquema                    |
| `source` / `environment`        | quem publicou e em qual ambiente (`prod`, `sandbox`)           |
| `occurredAt`                    | quando aconteceu, no **relógio do ambiente** (grupo 3)         |
| `partitionKey`                  | a chave de ordem (ex.: `account_id`)                           |
| `correlationId` / `causationId` | rastreio: o fluxo inteiro e "qual evento causou este" (INV-07) |
| `actor`                         | quem iniciou (usuário, serviço, sistema, backoffice)           |
| `auditable`                     | se vai para a trilha de auditoria                              |
| `payload`                       | os dados do evento                                             |

O esquema é escrito em **TypeBox** (gera JSON Schema a partir de TypeScript) e validado com **Ajv**. Os esquemas **não** proíbem campos extras: o consumidor ignora o que não conhece (**tolerant reader**, RN-MSG-B-022). Assim um produtor pode adicionar um campo opcional sem quebrar quem já consome.

`causedBy(eventoPai, contexto)` monta um evento que **herda** o `correlationId` do pai e aponta o `causationId` para ele: dá para seguir uma ordem do envio até a nota de corretagem.

### O que o `EventPublisher` recusa

Ele grava o evento na **outbox** dentro da transação do caso de uso, mas antes faz três checagens. Um evento inválido nem chega à outbox (falha no produtor, onde o erro é barato):

1. **Esquema**: o payload precisa bater com a definição do evento.
2. **Dado pessoal** (RN-MSG-B-013): CPF, documento, endereço, telefone, e-mail e data de nascimento nunca vão em eventos; vão IDs. A checagem percorre o payload inteiro (inclusive objetos aninhados e listas) e normaliza os nomes, então `cpf`, `taxId`, `tax_id` e `TAX-ID` são todos pegos.
3. **Tamanho** (RN-MSG-B-014): no máximo 256 KB. Conteúdo grande vai para o storage e o evento leva a referência. O teste confirma que 300 KB são recusados.

Depois de gravar, ele faz `pg_notify('outbox_event')`. O `NOTIFY` do PostgreSQL só é entregue **no commit**: se a transação fizer rollback, o relay nem é acordado.

---

## 5.3 — O relay da outbox

### O problema do "dual write"

Um caso de uso precisa fazer duas coisas: gravar no banco e publicar no barramento. Se fizer uma depois da outra:

- grava e cai antes de publicar → o evento **se perde**;
- publica e o commit falha → todo mundo reage a algo que **não aconteceu**.

A **outbox** resolve: o evento é gravado numa tabela **na mesma transação** do estado (ou os dois existem, ou nenhum). Um processo separado, o **relay**, lê a outbox e publica.

### Como o `OutboxRelay` funciona

1. Acorda por `LISTEN outbox_event` (aviso imediato) e também por **polling** a cada segundo (rede de segurança se um aviso se perder).
2. Numa transação: `SELECT ... WHERE published_at IS NULL ORDER BY seq FOR UPDATE SKIP LOCKED`.
   - `ORDER BY seq`: ordem de inserção.
   - `FOR UPDATE`: trava as linhas.
   - `SKIP LOCKED`: se outro relay já travou algumas, pula em vez de esperar.
3. Publica o lote e **espera a confirmação do broker**.
4. Marca `published_at` e faz commit.

E se o relay cair **entre o passo 3 e o 4**? A transação é desfeita, as linhas continuam pendentes, e o próximo relay publica **de novo**. Duas defesas evitam o efeito duplicado:

- **Deduplicação no broker**: cada mensagem vai com `publishingId = seq` e um `publisherRef` fixo. O broker lembra o maior id que viu e descarta reenvios. Na prática, a republicação nem chega ao stream.
- **Inbox no consumidor** (5.4): mesmo que chegue duas vezes, o efeito acontece uma vez. Essa é a **garantia**; a do broker é otimização. Motivo: se o banco do serviço for restaurado de um backup, o `seq` volta para trás e o broker descartaria eventos **novos** como duplicatas. Por isso o `publisherRef` tem uma "época" que muda após uma restauração.

### O teste com morte real

O relay roda num **processo separado** (`test/fixtures/relay-process.ts`). Com `RELAY_CRASH=1`, ele se mata com `SIGKILL` dentro do gancho `afterPublish`, exatamente entre confirmar e marcar. O teste verifica:

1. o processo morreu por `SIGKILL` depois de imprimir `PUBLISHED 5`;
2. as 5 linhas continuam pendentes na outbox;
3. um relay novo publica e marca tudo;
4. o consumidor aplicou cada efeito **uma vez**, na ordem de cada conta;
5. o stream tem **uma** cópia de cada evento (o broker deduplicou).

Um segundo cenário troca a época do `publisherRef`: o stream fica com **duas** cópias, e mesmo assim o efeito acontece uma vez (a inbox segurou).

A limpeza apaga os eventos publicados há mais de 7 dias (D7).

---

## 5.4 — O `EventConsumer`

Para cada mensagem do stream, numa **única transação** (`applyOnce`):

```
1. a chave está bloqueada?  → estaciona a mensagem (5.6) e grava o offset
2. INSERT INTO processed_event (event_id, consumer) ON CONFLICT DO NOTHING
     inseriu?   → é nova: valida o payload e roda o handler (o efeito)
     conflitou? → já processada: não faz nada
3. grava o offset da partição em consumer_offset
COMMIT
```

Por que tudo junto: se o efeito fosse gravado e o offset não (queda no meio), a mensagem seria relida e o efeito repetido. Com efeito, inbox e offset na mesma transação, **ou tudo aconteceu ou nada aconteceu**. Isso transforma a entrega "pelo menos uma vez" do barramento em efeito **exatamente uma vez** (RN-MSG-B-030/031).

Outros comportamentos:

- **Retomada pelo offset**: ao virar a instância ativa de uma partição, o callback lê `consumer_offset` e retoma do próximo. O teste para o consumidor, publica 3 eventos, sobe outro, e confere que o handler rodou **só 3 vezes** (nada relido do início).
- **Outro ambiente** (RN-MSG-B-012): mensagem com `environment = sandbox` num consumidor de `prod` vai para a DLQ sem efeito. É a defesa contra o sandbox contaminar a "produção".
- **Mensagem sem `eventId`** ou que não é JSON: erro **permanente**, DLQ direto.
- **Versão diferente** (RN-MSG-B-021): durante uma migração de esquema o produtor publica as duas versões; o consumidor trata só a que declarou e ignora a outra (sem DLQ).
- **Em série por partição**: a `SerialQueue` encadeia as mensagens de cada partição (achado 4 do spike).

---

## 5.5 — Retentativas

Erros se dividem em dois tipos (RN-MSG-B-033/034):

| Tipo            | Exemplo                               | O que fazer                               |
| --------------- | ------------------------------------- | ----------------------------------------- |
| **Transitório** | banco fora do ar, timeout             | tentar de novo, esperando mais a cada vez |
| **Permanente**  | payload fora do esquema, bug de regra | repetir não adianta: DLQ direto           |

No código, permanente é qualquer `PermanentError` (ou o erro de esquema); todo o resto é tratado como transitório.

A escada de um erro transitório:

```
5 tentativas locais, backoff 100 ms → 200 → 400 → 800 → 1,6 s (teto 5 s)
   └ falhou → fila retry.1m  (espera 1 min)  → 1 tentativa
        └ falhou → fila retry.10m (espera 10 min) → 1 tentativa
             └ falhou → fila retry.1h (espera 1 h) → 1 tentativa
                  └ falhou → DLQ
```

**Backoff exponencial** é dobrar a espera a cada falha: dá tempo para o problema se resolver sem martelar o banco que já está com dificuldade.

### Como a espera funciona sem `setTimeout`

As filas `retry.*` são **quorum queues com TTL** e ninguém as consome. A mensagem fica parada até o TTL vencer; aí o RabbitMQ a manda (_dead-lettering_) para a fila `retry.return`, que o consumidor escuta. É um "timer" feito pelo próprio broker: sobrevive a reinícios do serviço, o que um `setTimeout` em memória não faria.

O teste usa atrasos de 300/600/900 ms e grava uma **linha do tempo** das tentativas, conferindo: 6 falhas e 1 sucesso, intervalos locais crescentes (20, 40, 80, 80 ms com o backoff de teste), e os intervalos das filas respeitando os atrasos.

---

## 5.6 — Bloqueio por chave

### O problema

No ledger, a ordem importa: um débito antes do crédito correspondente pode deixar saldo negativo. Se o evento A1 da conta A falha e vai para a DLQ, o que fazer com A2 e A3?

- Processar mesmo assim → **fora de ordem**.
- Parar o consumidor inteiro → as contas B, C, D… também param por causa de A.

A solução (RN-MSG-B-035) é **bloquear só a chave A**:

```
A1 falha   → DLQ + blocked_key(A)
A2 chega   → A está bloqueada → parked_message (estacionada), offset avança
B1 chega   → B livre → processa normalmente
A3 chega   → estacionada atrás de A2
...
operador resolve A1 → reprocessa A2, A3 em ordem → apaga blocked_key(A)
```

Em consumidores **não ordenados** (ex.: notificações), a DLQ não bloqueia: um e-mail que falhou não deve segurar os outros.

### A decisão deste grupo

O design bloqueava a chave **só quando a mensagem chegava à DLQ**. Mas a mensagem passa antes por até ~1h11 de retentativas atrasadas, e nesse tempo A2 e A3 seriam processadas **na frente** de A1. Foi uma lacuna do design encontrada na implementação. A decisão tomada: **bloquear já na primeira retentativa atrasada** (`blocked_key.reason = 'RETRYING'`). Se a retentativa der certo, as estacionadas rodam e a chave é liberada; se esgotar, o bloqueio só muda para `DEAD_LETTER`.

Como a migração-base já tinha sido aplicada no banco `example`, a mudança veio numa **migração nova** (`0000_platform_blocked_key_retry`), nunca editando a antiga. Regra de ouro das migrações: o que já rodou em algum lugar não se edita.

### A corrida entre estacionar e liberar

Dois fluxos mexem na mesma chave ao mesmo tempo: o consumidor do stream (que pode estacionar uma mensagem nova de A) e a liberação (que processa as estacionadas e apaga o bloqueio). Sem cuidado:

1. a liberação vê "não há mais estacionadas" e apaga o bloqueio;
2. no mesmo instante, o stream viu o bloqueio ainda lá e estacionou A5;
3. A5 fica presa para sempre (não há mais bloqueio para liberar).

A solução é um `SELECT ... FROM blocked_key ... FOR UPDATE` **nos dois fluxos**. A linha do bloqueio vira um cadeado: ou o stream estaciona antes de a liberação conferir (e ela vê A5 e a processa), ou o stream espera a liberação terminar e então vê a chave livre e processa A5 normalmente. O teste publica A4 **durante** o bloqueio e confere a ordem final 1, 2, 3, 4, 5.

---

## 5.7 — A ferramenta de DLQ

Uma mensagem na DLQ precisa de uma decisão humana (RN-MSG-B-036):

| Operação        | O que faz                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------- |
| **listar**      | mensagens por status e consumidor, com "está bloqueando?" e "quantas estacionadas atrás"          |
| **inspecionar** | envelope completo, erro, tentativas, origem (stream, partição, offset)                            |
| **reprocessar** | roda o handler de novo (opcionalmente com o envelope **corrigido**); se der certo, libera a chave |
| **descartar**   | exige justificativa; gera o evento auditável `messaging.dead_letter_discarded`; libera a chave    |

Três peças:

- `DlqAdmin`: a lógica.
- `createDlqHttpHandler`: a **API administrativa** em `/admin/dlq`, escrita sem framework (só `node:http`). O Express do grupo 6 consegue montá-la. A autenticação fica por conta de quem monta a rota.
- `broker-dlq` (CLI): fala com a API por HTTP.

Por que a CLI passa pela API em vez de ir direto ao banco? Porque **reprocessar roda o handler**, e o handler só existe dentro do processo do serviço. A CLI é só um controle remoto.

O teste cobre: reprocessar com o bug ainda presente falha, conta a tentativa e mantém a chave bloqueada; depois da correção, reprocessa e as estacionadas rodam em ordem; descartar com justificativa em branco é recusado (422); descartar com justificativa grava o evento auditável e libera a chave.

---

## 5.8 — Filas de jobs

Jobs são trabalhos (ex.: gerar 10 mil notas de corretagem) em vez de fatos. A fila de jobs (`JobQueue`) é quorum, com:

- **ack manual**: o job só sai da fila quando o worker confirma que terminou;
- **prefetch**: quantos jobs um worker segura ao mesmo tempo (o resto espera os outros workers);
- **DLQ por fila**: o job que falha sempre não fica girando para sempre.

Se o worker **morre** no meio do job (sem ack), o broker devolve o job para a fila e outro worker o recebe. O teste usa de novo um **processo real**: o worker A recebe o job e trava; o worker B fica de prontidão sem receber nada (o job está com A); A é morto com `SIGKILL`; B recebe o job com `deliveryCount: 2`.

### O achado do RabbitMQ 4

O plano era usar o `x-delivery-limit` da fila quorum: depois de N entregas, o broker manda o job para a DLQ. O teste do job que sempre falha **não terminou**, e a investigação mostrou **2.655 entregas em 3 segundos**, todas com `deliveryCount = 1`. No RabbitMQ 4, um `nack` com requeue **não incrementa** o contador de entregas (só as devoluções por queda do worker contam). Resultado: um laço apertado de reentrega que nunca chegaria à DLQ.

Correção: o worker **conta as próprias falhas** num cabeçalho (`x-broker-retries`). Em caso de falha, espera um pouco, republica o job com o contador +1 e confirma o original. No limite, publica na DLQ da fila. O teste confere exatamente três entregas, `[1, 2, 3]`, e a fila vazia. O `x-delivery-limit` continua configurado como rede de proteção para workers que caem em laço (essas quedas o broker conta).

---

## Problemas no caminho

1. **Os achados do spike** (5.1): quatro limitações do cliente de streams, cada uma com contorno e registro na ADR.
2. **Tipos que a biblioteca não exporta** (`Message`, `SuperStreamConsumer`): derivados da assinatura pública com `Parameters<Client['declareConsumer']>`. É um truque útil de TypeScript para extrair tipos de funções de bibliotecas.
3. **`switch` com fallthrough** no murmur3: o `tsconfig` estrito (grupo 1) proíbe cair de um `case` no outro sem querer. Reescrito com `if`.
4. **O `nack` do RabbitMQ 4** (5.8): o laço de 2.655 reentregas.
5. **`count(*)` como `bigint`**: um teste comparou `count(*)` com a string `'2'`, mas desde o grupo 4 o `int8` do PostgreSQL vira `bigint` no JavaScript. Era o teste que estava errado.
6. **Um falso positivo na verificação (o mais instrutivo).** A suíte completa mostrava "35 passed | 3 skipped". Os 3 pulados eram justamente os testes do **relay**, os mais importantes: dois arquivos de teste usavam o mesmo banco com migrações diferentes, e o que rodava depois falhava no `beforeAll` com "corrupted migrations". O Vitest marca os testes de um arquivo que quebrou no setup como _skipped_, e a checagem olhava só a linha `Tests`, não a linha `Test Files 1 failed` nem o código de saída. Corrigido o conflito (cada arquivo com seu banco), a checagem passou a conferir o **código de saída** e a linha de arquivos.

   Lição: "verde" na tela não é "passou". Confira o código de saída e desconfie de qualquer `skipped` que você não escreveu.

---

## Pendências e pontos de atenção

- Os contornos 2 e 3 dependem do comportamento interno do cliente de streams 1.1.0: antes de atualizar a biblioteca, rodar o spike.
- Época do `publisherRef`: trocar depois de restaurar o banco de um backup.
- As DLQs são por consumidor (`<env>.<consumidor>.dlq`); igual ao `<env>.<svc>.dlq` do design quando o serviço tem um consumidor só.
- Rodar **um único relay ativo** por serviço (com o `LeaderElector` do grupo 4), para não publicar lotes da mesma chave em paralelo.

---

## Para experimentar

Rodar a suíte de mensageria (sobe RabbitMQ e PostgreSQL temporários):

```bash
pnpm exec vitest run --project messaging
```

Rodar só o spike:

```bash
pnpm exec vitest run --project messaging test/spike
```

Com o ambiente local no ar (`pnpm env:up infra`), abra a UI do RabbitMQ em http://localhost:15672 (usuário `broker`, senha em `infra/secrets/rabbitmq_password`). Durante os testes não aparece nada ali, porque eles usam um RabbitMQ próprio; mas quando os serviços da Fase 1 existirem, as abas _Streams_ e _Queues_ mostram os super streams, as filas `retry.*` e as DLQs.

Para ver o roteamento por chave: em `test/routing.test.ts`, troque a semente 104729 do `murmur32` em `src/stream/routing.ts` por outro número e rode o teste. Ele falha mostrando que o nosso roteamento divergiu do oficial.

O próximo grupo (6) é o **service kit**: o bootstrap Express de cada serviço, com configuração validada, logs, métricas, traces, health, Problem Details (RFC 9457), idempotência de API e autenticação. É lá que a API da DLQ ganha rota e proteção.
