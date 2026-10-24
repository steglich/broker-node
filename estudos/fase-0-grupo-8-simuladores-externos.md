# Fase 0, grupo 8 — Simuladores externos

> Tarefas 8.1 a 8.5 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/external-simulators/spec.md`. Regras: `broker-docs/docs/02-integracoes/02-sistemas-simulados.md` (RN-SIM-_, RN-PIXS-_, RN-KYCS-001, RN-MSG-001..003) e `01-dominio/02-contas-e-onboarding.md` §5 (KYC).

## Visão geral

Uma corretora real depende de terceiros: um banco para o PIX, um provedor de KYC e serviços de entrega de e-mail, SMS e push. O grupo 8 cria esses terceiros como **serviços separados**, com banco próprio, API própria e falhas configuráveis. O objetivo é que a integração com eles seja estudada como integração de verdade: rede, webhooks, assinaturas, retentativas e indisponibilidade.

| Peça                                                | Onde                                 | Tarefa   |
| --------------------------------------------------- | ------------------------------------ | -------- |
| assinatura, verificação e entrega de webhooks       | `packages/webhooks`                  | 8.1      |
| falhas configuráveis, cenários forçáveis, UI        | `packages/simulator-kit`             | 8.2–8.5  |
| Banco Simulado (PIX)                                | `apps/pix-simulator`                 | 8.2, 8.3 |
| provedor de KYC                                     | `apps/kyc-simulator`                 | 8.4      |
| caixa de SMS e push + lista de permissão do Mailpit | `apps/message-sink`, `infra/compose` | 8.5      |

```
                 núcleo (ledger, customer, notification…)  ← ainda não existe
                   │ API (adaptador com ACL)        ▲ webhook assinado
                   ▼                                │
   ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐   ┌─────────┐
   │ pix-simulator        │  │ kyc-simulator        │  │ message-sink     │   │ Mailpit │
   │ bank.broker.localhost│  │ kyc.broker.localhost │  │ sms.broker.local │   │ mail.*  │
   └──────────┬───────────┘  └──────────┬───────────┘  └────────┬─────────┘   └─────────┘
              ▼                         ▼                       ▼
        pix_simulator             kyc_simulator            message_sink     (databases próprios)
```

## 8.1 — Webhooks

### A assinatura

```
X-Timestamp: 1772456400
X-Signature: hex( HMAC-SHA256( segredo, "1772456400" + "." + corpo ) )
```

Por que o timestamp entra **dentro** da assinatura? Se a assinatura cobrisse só o corpo, quem capturasse um webhook poderia reenviá-lo para sempre. Com o timestamp assinado, o receptor recusa qualquer webhook com desvio maior que 5 minutos, e trocar o header invalida a assinatura. É o mesmo esquema do Stripe e do Slack.

O receptor tem três cuidados:

1. **Bytes exatos.** A assinatura é sobre o corpo como chegou. Se o receptor fizer `JSON.parse` e depois `JSON.stringify`, espaços e ordem de campos mudam e a assinatura não confere mais. Por isso o service-kit passou a guardar `req.rawBody` (o `express.json` recebeu um `verify` que copia o buffer).
2. **Comparação em tempo constante** (`timingSafeEqual`). Uma comparação comum para no primeiro byte diferente, e o tempo de resposta vaza quantos bytes o atacante acertou.
3. **Desvio nos dois sentidos.** Um timestamp 6 minutos no futuro também é recusado.

No núcleo, a rota de webhook fica assim:

```ts
handler: async (req) => {
  assertWebhookSignature(req, { secret, clock }); // 401 INVALID_WEBHOOK_SIGNATURE, antes de qualquer efeito
  ...
}
```

### Entrega pelo menos uma vez

O `WebhookDispatcher` é uma fila **no banco do simulador** (`webhook_delivery`), gravada na mesma transação da operação. O pagamento de uma cobrança e o webhook dele são confirmados juntos: se o simulador cair logo depois, o webhook continua na fila.

```
tentativa 1 ── 503 ──► +1 s ─► 2 ── 503 ──► +5 s ─► 3 ── 200 ──► DELIVERED
backoff: 1 s, 5 s, 30 s, 2 min, 10 min, 1 h, e depois de hora em hora até 2xx
```

Dois detalhes:

- **Cada tentativa é assinada de novo** com a hora do envio. Se a assinatura fosse calculada na criação, a tentativa de 1 h depois chegaria com um timestamp vencido e seria recusada para sempre. O teste "cada tentativa chega assinada e válida" verifica isso.
- **`X-Webhook-Id` é o mesmo em todas as tentativas.** Entrega "pelo menos uma vez" significa que o receptor pode receber duplicatas, e esse ID é a chave de idempotência dele (RN-SIM-004: "o receptor DEVE ser idempotente").

O despachante usa o relógio injetado, então nos testes o backoff é exercitado com o relógio virtual: `clock.advanceBy(1_000)` e `runDue()`, sem esperar 1 h de verdade.

## `@broker/simulator-kit`: o que os três simuladores têm em comum

### Comportamento configurável (RN-SIM-002)

Um middleware na frente da API aplica, nesta ordem:

| Falha             | Resposta                                      | Para exercitar no núcleo      |
| ----------------- | --------------------------------------------- | ----------------------------- |
| indisponibilidade | `503 SIMULATED_UNAVAILABLE` + `Retry-After`   | disjuntor, fila de espera     |
| latência          | atraso fixo (`200`) ou uniforme (`100-500`)   | timeouts                      |
| erro transitório  | `503`, ou conexão pendurada que cai (timeout) | retentativa com backoff       |
| erro definitivo   | `422 SIMULATED_DEFINITIVE_ERROR`              | não tentar de novo; compensar |

A distinção entre transitório e definitivo é a mais importante: o núcleo precisa tratar os dois de formas opostas. A aleatoriedade é injetável; nos testes, um PRNG semeado faz "50% de erro" dar sempre o mesmo resultado.

As rotas de UI e de controle (`/ui`, `/admin/*`) são registradas **antes** do middleware, então nunca falham. Para isso, o `Service` ganhou `use()`: o middleware vale para as rotas registradas depois dele.

### Cenários forçáveis e UI (RN-SIM-005)

O `SimulatorControl` também guarda cenários de **uso único**: "o próximo PIX enviado falha", "o próximo webhook vai duplicado". Cada operação consulta o cenário com `consume()`, que desarma na hora. Isso permite testar casos raros de forma determinística, sem depender de sorte.

A UI é HTML renderizado no servidor, sem framework: uma tag `html```…`` ` escapa toda interpolação, porque nomes e descrições vêm de quem chama a API e são dados não confiáveis. Para responder HTML, o `HandlerResult` do service-kit ganhou o campo `type`.

## 8.2 e 8.3 — Banco Simulado (PIX)

### API de terceiro, nomes de terceiro

A API segue o estilo da API Pix do Banco Central: `PUT /cob/:txid`, `endToEndId`, `pixCopiaECola`, `PUT /pix/:e2eid/devolucao/:id`. Ela **não** usa os nomes do núcleo, e isso é proposital: a spec pede que "os nomes de campo do simulador não apareçam em eventos, tabelas ou APIs do ledger". O adaptador do ledger (Fase 1) fará a tradução (ACL). O contrato está em `contracts/http/pix-simulator.ts` e o OpenAPI é gerado pelo grupo 7.

### Idempotência natural

Nenhuma rota exige `Idempotency-Key`, porque cada operação tem uma chave própria do negócio:

| Operação       | Chave             | Repetição                                        |
| -------------- | ----------------- | ------------------------------------------------ |
| criar cobrança | `txid`            | mesmo corpo → `200`; outro → `409 TXID_EM_USO`   |
| enviar PIX     | `idEnvio`         | devolve o mesmo resultado, inclusive a recusa    |
| devolver       | `id` da devolução | mesmo id → `200`; outro → `409 PIX_JA_DEVOLVIDO` |
| abrir conta    | (tipo, CPF)       | devolve a mesma conta                            |

A recusa de um envio também é gravada (`NAO_REALIZADO` + motivo). Isso serve à idempotência e à reconciliação diária (RN-PIXS-002), que precisa ver todas as tentativas.

### Saldo nunca negativo

O débito é um `UPDATE account SET balance = balance - x WHERE id = ? AND balance >= x`. Se nenhuma linha muda, o saldo era insuficiente. É atômico no banco, então dois envios concorrentes não gastam o mesmo saldo (sem ler e depois escrever). O `CHECK (balance >= 0)` é a rede de segurança.

### `end_to_end_id` e BR Code

- `ESIM` + `AAAAMMDDhhmmss` + sequência de 14 caracteres em base 36 (de uma `SEQUENCE`) = 32 caracteres. O tamanho segue o padrão, mas o prefixo deixa claro que o ID é simulado (RN-PIXS-001).
- O "copia e cola" é EMV de verdade (TLV com CRC16-CCITT), com o GUI `br.sim.pix` no lugar de `br.gov.bcb.pix`. O formato é realista, mas nenhum app de banco real aceitaria pagar.

### Pagamento por terceiro

O webhook `pix.recebido` traz o **pagador real**, não o devedor da cobrança. É por isso que o núcleo consegue detectar que a cobrança do cliente X foi paga pela conta de outro CPF e devolver o valor.

### Cenários do RN-PIXS-003

| Cenário                     | Como é implementado                                              |
| --------------------------- | ---------------------------------------------------------------- |
| pagamento duplicado         | duas entregas na fila com o mesmo corpo e o mesmo `X-Webhook-Id` |
| webhook atrasado            | `notBefore` = expiração da cobrança + 1 min                      |
| chave inexistente no saque  | `CHAVE_INEXISTENTE` mesmo para uma chave válida                  |
| indisponibilidade de 10 min | janela no `SimulatorControl` (botão "Derrubar" na UI)            |
| saldo insuficiente          | `SALDO_INSUFICIENTE` mesmo com saldo                             |

## 8.4 — Provedor de KYC

### Assíncrono como um fornecedor real

`POST /v1/checks` grava a submissão e responde `202` na hora. Um processador (`runDue`, igual ao despachante) pega as verificações vencidas, depois da latência de 2 a 10 s (RN-ONB-021), e emite **um webhook por verificação** mais um `check.completed`. A API usa outro estilo, snake_case em inglês, como faria um segundo fornecedor: o núcleo vai precisar de dois adaptadores diferentes.

### Regras pelo penúltimo dígito

O penúltimo dígito do CPF é o **primeiro dígito verificador**, então o CPF continua válido e o `generateCpf({ penultimateDigit })` do grupo 3 consegue escolhê-lo. O teste cobre 0–6 (aprova tudo), 7 (FACE_MATCH 50–79, `ATTENTION`), 8 (WATCHLIST) e 9 (CPF irregular).

### Documentos sem retenção (RN-KYCS-001)

1. A submissão só aceita **URL pré-assinada** (SigV4: `X-Amz-Signature`, `X-Amz-Expires`). Um link permanente é recusado com `DOCUMENT_URL_NOT_SIGNED`.
2. O documento é lido uma vez e analisado **em memória**. O formato é identificado pelos bytes iniciais (`%PDF-`, assinatura PNG, `FF D8 FF` do JPEG), e não pela extensão; a resolução sai do cabeçalho (IHDR do PNG, marcador SOF do JPEG). O limite de 10 MB é contado durante o download, que para assim que estoura.
3. Ao concluir, as URLs saem do banco junto com a mudança de status. O banco não tem nenhuma coluna `bytea`, e um teste confere isso.

O teste usa MinIO de verdade (`startMinio` no `@broker/testing`) e `getSignedUrl` do SDK da AWS, como o customer-service fará. A "referência expirada" é uma URL com validade de 1 s. Ali o teste espera 2 s de relógio **real**, porque quem valida a expiração é o MinIO, que não conhece o relógio virtual.

## 8.5 — SMS, push e e-mail

O `message-sink` faz o papel da operadora de SMS e do serviço de push. Cada mensagem fica registrada com o status de entrega (`DELIVERED`/`FAILED` + motivo, RN-MSG-003) e aparece na UI.

O e-mail vai para o **Mailpit**, que já existia desde o grupo 2. O que faltava era a lista de permissão. O Mailpit tem um recurso de relay: `MP_SMTP_RELAY_MATCHING` repassa automaticamente a um SMTP externo **só** os destinatários que casam com uma regex, e continua guardando tudo na caixa de captura. No compose:

```yaml
MP_SMTP_RELAY_HOST: ${MAIL_RELAY_HOST:-} # sem host: relay desligado
MP_SMTP_RELAY_MATCHING: ${MAIL_RELAY_ALLOWLIST:-} # repasse automático
MP_SMTP_RELAY_ALLOWED_RECIPIENTS: ${MAIL_RELAY_ALLOWLIST:-^$} # trava também o "release" manual da UI
```

O padrão de `ALLOWED_RECIPIENTS` é `^$` (uma regex que não casa com nenhum endereço), e não vazio. Vazio significaria "qualquer destinatário" para o botão de release manual da UI.

A verificação (`mailpit-allowlist.test.ts`) **lê o bloco `environment` do `compose.yml`**, resolve os `${VAR:-padrão}` e sobe dois Mailpit numa rede Docker: a caixa de captura e um segundo no papel do "SMTP real". O teste envia para `cliente@gmail.com` e para `dev@exemplo.com`: a caixa de captura fica com os dois e o "SMTP real" recebe só o segundo. Como o teste usa a configuração do compose, uma mudança errada nela reprova o teste.

## Mudanças fora das tarefas

- **service-kit**: `service.use()`, `HandlerResult.type` (respostas não JSON) e `req.rawBody`.
- **`@broker/testing`**: `startMinio()`.
- **compose**: os três simuladores (com migração one-shot) entram no perfil `infra`, com Traefik em `bank.`, `kyc.` e `sms.broker.localhost`. Os segredos HMAC ficam em `infra/secrets/webhook/`, gerados pelo `env:up`.
- **contratos**: `contracts/http/{pix-simulator,kyc-simulator,message-sink}.ts`, com OpenAPI em `contracts/generated/openapi/`.

## Problemas no caminho

- **`TRUNCATE` negado nos testes.** O papel `<svc>_app` só tem DML (grupo 2), e `TRUNCATE` não é DML. Os testes limpam as tabelas com `DELETE`. O erro confirmou que o isolamento de permissões está funcionando.
- **Prettier e o JSON gerado.** Mesmo problema do grupo 7: `contracts/generated/` já estava no `.prettierignore`.
- **Um teste do `messaging` instável sob carga.** Na suíte completa, o teste de retentativa da DLQ falhou uma vez e passou isolado duas vezes. É um prazo de tempo real apertado, não uma mudança deste grupo; ficou registrado como tarefa separada.

## Para experimentar

```bash
pnpm env:up infra
open https://bank.broker.localhost/ui     # contas, cobranças (botão Pagar), PIX, webhooks, falhas

curl -s --cacert infra/certs/ca/rootCA.pem https://bank.broker.localhost/contas \
  -H 'content-type: application/json' -d '{"cpf":"39053344705","nome":"Maria da Silva"}'
curl -s --cacert infra/certs/ca/rootCA.pem -X PUT https://bank.broker.localhost/cob/txidteste00000000000000000001 \
  -H 'content-type: application/json' -d '{"calendario":{"expiracao":3600},"valor":{"original":"25.00"}}'
# pague pela UI e veja o webhook pix.recebido tentando entregar (PENDING até o ledger existir)

# derrube o banco por 10 min e veja o 503 com Retry-After
curl -s --cacert infra/certs/ca/rootCA.pem https://bank.broker.localhost/admin/unavailability \
  -H 'content-type: application/json' -d '{"minutes":10}'
```
