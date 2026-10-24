# Fase 1, grupo 14 — customer-service

> Tarefas 14.1 a 14.8 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/customer-onboarding/spec.md`. Regras: `broker-docs/docs/01-dominio/02-contas-e-onboarding.md` (RN-ONB, RN-SUI, RN-ACC, RN-CAD, RN-TER), catálogo de serviços §2, catálogo de eventos §2, Mensageria, Fluxos §1, Sistemas simulados §2–§3. Design: D16 (MinIO), D18 (cifra de campo), RN-PAD-030 (saga).

## Visão geral

O customer-service leva uma pessoa de "tem login" a "tem conta ativa" e cuida dela depois:

```
identity.user_registered ─▶ STARTED ─▶ contato ─▶ dados ─▶ endereço ─▶ perfil ─▶ documentos ─▶ suitability ─▶ termos
                                                                                                              │ submit
KYC simulado ◀── documentos por URL assinada ──────────────────────────────────────────────────── UNDER_REVIEW ┘
     │ webhooks assinados
     ▼
APPROVED ─▶ saga: cliente + conta NNNNNNN-D + eventos ─▶ conta no Banco Simulado
MANUAL_REVIEW ─▶ backoffice aprova/reprova/pede correção
REJECTED
```

Depois da abertura vêm o status da conta (com a matriz de permissões), o suitability, os termos, as contas de saque e a manutenção cadastral.

## Decisões tomadas no apply

- **Pendências de encerramento** (decidido com o dono): uma porta `ClosureCheck` com um verificador por dono (ledger, custódia, aluguel, liquidação, IR). O adaptador é HTTP, `GET /v1/internal/accounts/{id}/closure-pendencies` com token de serviço, e cada serviço implementa a rota no seu grupo. São consultas internas fora dos três RPCs do D11, registradas como desvio. Sem os cinco verificadores, ou com algum fora do ar, o encerramento responde `503`: uma pendência desconhecida conta como pendência.
- **OTP do contato e das trocas de cadastro**: sai direto do serviço (SMTP → Mailpit, HTTP → message-sink), como o identity faz com os segredos dele (grupo 13).
- **Reautenticação da troca de contato** (RN-CAD-001): é a assinatura eletrônica (escopo `SETTINGS`). Prova o segredo do cliente sem depender de ele ter MFA. O cadastro de conta de saque exige assinatura **e** MFA recente (RN-ACC-021 + RN-AUTHZ-003).
- **Elegibilidade**: a matriz de permissões, os termos pendentes e o suitability vencido saem numa rota interna (`customer:eligibility`). O OMS, o ledger e os BFFs perguntam ali; os eventos (`account.status_changed` com `restrictions`, `suitability.*`) alimentam caches.
- **Aprovação de PEP**: só `BO_ADMIN` aprova (Backoffice §3). O desbloqueio de conta também fica com `BO_ADMIN`; a dupla aprovação de verdade chega com o approval-service (grupo 33).

## 14.1 — Etapas, validações e CPF único

Cada etapa salva um **rascunho** em `onboarding_application.draft`, um `jsonb` com um campo cifrado por etapa (`contactEnc`, `personalEnc`...). Retomar de outro canal é ler o mesmo registro: o teste usa outro token do mesmo usuário e encontra a próxima etapa e os dados. A ordem é rígida (`STEP_OUT_OF_ORDER` para quem pula), mas refazer uma etapa anterior não volta o progresso.

A solicitação nasce de duas formas, e as duas são idempotentes (`user_id` único): pelo `identity.user_registered` do realm `customers` ou pela primeira leitura (`GET /v1/me/onboarding`). A segunda cobre o caso em que o evento ainda não chegou.

**CPF único** (RN-ONB-004), com duas barreiras:

- índice único parcial em `onboarding_application (tax_id_hash)` para as solicitações ativas;
- consulta ao `customer` não encerrado (o índice `customer_tax_id_open` garante o resto).

O hash é HMAC com chave do serviço (`BlindIndex`): o banco nunca vê o CPF em claro nem um hash que dê para testar por força bruta. A violação do índice vira `TAX_ID_ALREADY_REGISTERED` dentro de um `SAVEPOINT`, para não abortar a transação inteira.

**Idade** (`UNDERAGE`): calculada na data de negócio do relógio do ambiente, entre 18 e 120 anos. É `422` (regra), não `400` (formato).

## 14.2 — Documentos por URL assinada

```
app ─POST upload-url {tipo, content-type, tamanho}─▶ serviço ─▶ URL PUT assinada (10 min)
app ─PUT ──────────────────────────────────────────▶ MinIO (bucket documents)
app ─POST documents {id}───────────────────────────▶ serviço lê o objeto e confere
```

- O tamanho declarado já é conferido na URL: um documento de 12 MB nem recebe URL (`DOCUMENT_INVALID_FORMAT`, `reason: TOO_LARGE`). A URL assinada fixa `Content-Type` e `Content-Length`.
- Mesmo assim, o serviço **lê** o objeto depois: o tipo vem dos bytes iniciais (assinatura do PNG, `FFD8FF` do JPEG, `%PDF-`), e as dimensões vêm do cabeçalho IHDR ou do quadro SOF. Um "PNG" que é HTML é recusado e apagado do storage.
- O nome do objeto é do servidor (`onboarding/<solicitação>/<documento>`). Um documento novo do mesmo tipo substitui o anterior, que é apagado.

A mesma inspeção existe no KYC simulado. As duas cópias são de propósito: um app não importa código de outro, e a do simulador representa a do fornecedor.

Uma pegadinha: o MinIO assina a URL com o **host**. O navegador enxerga `localhost:9000`, e o KYC, dentro da rede, enxerga `minio:9000`. Por isso as URLs de upload são assinadas com o endereço público e as de leitura (para o KYC) com o interno.

## 14.3 — KYC: ACL, webhook e decisão

- **Submissão**: o adaptador traduz para a API do fornecedor (snake_case, inglês) com URLs de leitura de 30 min. A chamada acontece **antes** de mudar o estado: se o provedor falhar, nada muda e o cliente tenta de novo. Se ele aceitar e a gravação falhar, os webhooks daquele `check_id` órfão são ignorados.
- **Webhook**: assinatura HMAC conferida antes de tudo (`assertWebhookSignature`, grupo 8). Cada `check.verification_completed` grava um `kyc_check` com o payload bruto; `(provider_check_id, check_type)` é único, então a reentrega não duplica.
- **Decisão** (`check.completed`): só se aplica com a solicitação em `UNDER_REVIEW` e com o mesmo `check_id`. Um segundo `check.completed` não acha mais `UNDER_REVIEW` e não faz nada: o teste "webhook repetido" confere um `onboarding.approved` só.

| Resultado                                      | Decisão                          |
| ---------------------------------------------- | -------------------------------- |
| alguma verificação `FAIL` (FACE_MATCH < 50)    | `REJECTED`                       |
| alguma `REVIEW` (FACE_MATCH 50–79, WATCHLIST)  | `MANUAL_REVIEW`                  |
| tudo `PASS`, mas PEP ou residência no exterior | `MANUAL_REVIEW` (RN-ONB-010/011) |
| tudo `PASS`                                    | `APPROVED`                       |

Os quatro cenários do simulador (penúltimo dígito do CPF 0–6, 7, 8 e 9) estão num `it.each`.

## 14.4 — A saga de abertura

O desenho de RN-PAD-030 pede estado persistido e retomada. Usei o `SagaOrchestrator` do grupo 6 com dois passos:

1. **`create_customer_and_account`**: numa transação, cria o cliente (os dados do rascunho passam para colunas cifradas próprias), a conta `NNNNNNN-D` e grava na outbox `onboarding.approved`, `customer.created`, `account.opened` e `suitability.assessed`. Repetir o passo encontra o cliente da solicitação e devolve o que existe; os eventos já saíram junto com ele.
2. **`open_bank_account`**: abre a conta no Banco Simulado, que já é idempotente pelo CPF.

O ponto frágil é **entre** gravar `APPROVED` e criar a saga: são transações diferentes (o orquestrador usa a própria conexão). Se o processo cair ali, nenhuma saga existe para retomar. A retomada cobre esse caso: `approvedWithoutOpening()` busca as solicitações aprovadas sem cliente e sem saga e as inicia. Ela roda na subida e a cada 10 s. O teste simula exatamente essa queda e confere uma conta só, mesmo com três retomadas seguidas.

O **número da conta** vem de uma `SEQUENCE` (7 dígitos, a partir de 1000001) mais o dígito verificador módulo 11, com pesos 2 a 7 da direita para a esquerda. Um número queimado num rollback nunca é reutilizado (RN-ACC-001): é o oposto do `seq` da auditoria, onde o buraco era o problema.

## 14.5 — Suitability e termos

- O questionário v1 tem as oito perguntas de RN-SUI-002, com pontuação máxima 45 e faixas no próprio registro (`scoring.bands`). Mudar faixas ou pesos é publicar a versão 2. A resposta tem de ser da versão vigente (`QUESTIONNAIRE_OUTDATED`), e o questionário servido ao app não mostra os pesos.
- Durante o onboarding ainda não há cliente: a avaliação é do **usuário**, e o `suitability.assessed` sai na abertura, com `customerId` e `accountId`. Depois, cada avaliação nova sai na hora (RN-SUI-013: vale a mais recente).
- Rotina diária: `suitability.expiring` 30 dias antes e `suitability.expired` no vencimento, um aviso por avaliação (flags na linha).
- **Termos**: `terms_document (code, version)` com hash SHA-256 do conteúdo; o aceite é append-only, com IP, user agent e canal (RN-TER-002). Uma versão nova de termo obrigatório deixa a elegibilidade em `TERMS_PENDING` para tudo menos `LOGIN` ("só consulta", RN-TER-001).

## 14.6 — Status da conta

A matriz da Contas §7.2 virou dados (`permissions(status, restrictions)`). As restrições ficam numa lista: a conta fica `RESTRICTED` enquanto houver alguma e volta a `ACTIVE` quando a lista esvazia. Assim, saldo devedor e cadastro vencido convivem sem um apagar o outro. Toda mudança de status publica `account.status_changed` com motivo, ator e a lista de restrições (RN-ACC-010).

O consumidor do `ledger.negative_balance_*` está ligado atrás de `CONSUME_LEDGER_EVENTS` e foi testado pelo RabbitMQ, com o contrato já escrito (o ledger chega no grupo 15).

O **encerramento** pergunta aos cinco donos em paralelo, com timeout de 2 s cada. Com pendência, responde `422 ACCOUNT_CLOSURE_PENDING` com a lista e a conta não muda (o cenário dos R$ 50,00). Sem nenhuma, `ACTIVE → CLOSING → CLOSED`, com os dois eventos.

## 14.7 — Contas de saque e cadastro

- **Contas de saque**: o Banco Simulado devolve o CPF do titular da chave, que precisa ser o do cliente (`BANK_ACCOUNT_NOT_ALLOWED`). São no máximo 3 ativas e cada uma tem carência de 24 h (`availableFrom`). A chave fica cifrada, com HMAC para detectar duplicata.
- **Troca de e-mail ou celular**: o código vai para o canal antigo **e** para o novo. Quem tomou a conta e trocou o celular não recebe o código do antigo. Na troca de endereço não existe "canal novo", então os dois códigos vão para os canais atuais.
- **Troca de nome ou documento**: a alteração fica pendente, o cliente recebe uma URL para o documento novo e o backoffice decide.
- **Histórico** (RN-CAD-004): `customer_change_history` append-only, com valor anterior e novo cifrados, ator e data.
- **Cadastro vencido** (RN-CAD-003): 24 meses depois da última atualização, a rotina põe `REGISTRATION_EXPIRED`. Confirmar os dados (`POST /v1/me/profile/confirm`) ou alterar qualquer um renova a validade.

## 14.8 — Expiração e Banco Simulado

A expiração vale **pelo relógio**, não pela rotina: uma ação depois dos 30 dias já recebe `ONBOARDING_EXPIRED`, mesmo que a rotina ainda não tenha passado. A rotina `customer_daily` (agendador, 22:00) grava o `EXPIRED` e apaga os documentos do storage. Ela foi para depois do pregão porque às 06:00 virava a primeira rotina do dia e mudava a ordem que os testes do agendador esperavam. A conta no Banco Simulado é o segundo passo da saga (14.4).

## O que ficou de fora

- **Retenção dos documentos** além do descarte na expiração (política LGPD completa): Fase 7, grupo 44.
- **Consumo do `approval.request_approved`** (desbloqueio com dupla aprovação, PEP pelo checker): grupo 33.
- **Termos de day trade e de aluguel antes da primeira operação**: os termos existem e o aceite funciona; quem exige o aceite na hora da operação é o OMS (Fase 2) e o securities-lending (Fase 5).
- **Desenquadramento** (RN-SUI-010/011, alerta e `SUITABILITY_NOT_ALLOWED`): regra da ordem, no OMS. O customer-service entrega o perfil.
- **Busca de CEP**: conveniência de UI (Onboarding §4.2).

## Problemas no caminho

- **CPFs repetidos nos testes**: o `generateCpf` do grupo 7 usa `Date.now()` como semente, e duas chamadas no mesmo milissegundo davam o mesmo CPF (e `TAX_ID_ALREADY_REGISTERED` onde não devia). Os testes passam uma semente aleatória.
- **Coluna ambígua**: `SELECT *, registration_valid_until::text AS registration_valid_until` cria duas colunas com o mesmo nome, e o `ORDER BY` não sabe qual usar. O alias ganhou o sufixo `_text`.
- **Rotas com `Idempotency-Key` davam 500**: o service-kit exige o `IdempotencyStore` configurado para essas rotas. A tabela já vinha nas migrações-base; faltava ligar no `createService`.
- **`fetch` recusa `Content-Length`**: o undici calcula o cabeçalho e não aceita o manual. O teste do upload tirou o cabeçalho; a URL assinada continua exigindo o tamanho.
- **Validade dupla**: cadastro e suitability vencem os dois em 24 meses, e o teste do suitability vencido caía primeiro na conta restrita por cadastro vencido. O teste agora confirma o cadastro antes.

## Para experimentar

```bash
pnpm env:up core
# a fila de revisão, a caixa de SMS e o Mailpit mostram os códigos e as decisões
open https://mail.broker.localhost
open https://kyc.broker.localhost
```
