# notification-service

Transforma eventos de domínio em notificações do catálogo (Notificações §3–§4, catálogo de
serviços §17). Rotas em `contracts/generated/openapi/notification-service.json` (central,
preferências e tokens de push); eventos `notification.*` em `notification.events` (7 dias, chave
`userId`).

- **Catálogo** (`domain/catalog.ts`): canais padrão, prioridade, se pode desativar e o texto genérico
  do push de cada código. As obrigatórias ignoram a preferência (o `PUT` delas é `422`
  `NOTIFICATION_NOT_OPTIONAL`); o `DAILY_SUMMARY` nasce desligado.
- **Templates** (`notification_template`): versionados por código, canal (`ANY` vale para os canais sem
  template próprio) e `valid_from`; `{{variavel|filtro}}` com `money` (`R$ 1.500,50`, sem ponto
  flutuante), `int`, `date` e `datetime` (fuso America/Sao_Paulo). Variável ausente é erro do template.
  CPF que escape para o texto é mascarado (RN-NOT-G-003). Versão nova = migração nova.
- **Idempotência** (RN-NOT-G-004): `notification_source` reserva o par `(evento, código)` na
  transação do consumidor; cada notificação tem no máximo uma entrega por canal.
- **Central in-app** (RN-NOT-G-008): `GET /v1/me/notifications` (cursor, `unread=true`,
  `unreadCount`), `POST /v1/me/notifications/read` (IDs ou `all`) com `notification.read`; retenção de
  90 dias (o laço apaga a cada 10 min).
- **Entrega** (`application/dispatcher.ts`, RN-NOT-G-007): e-mail por SMTP (Mailpit no local), SMS e
  push pelo message-sink. Backoff exponencial até 24 h (e-mail) e 1 h (push e SMS); erro definitivo
  ou prazo vencido → `FAILED` e `notification.failed`. Sem aparelho registrado → `SKIPPED`. Aparelho
  que o provedor diz não registrado vira `UNREGISTERED`. Várias instâncias dividem as entregas por
  `FOR UPDATE SKIP LOCKED`, com reserva de 2 min.
- **Silêncio** (RN-NOT-G-006): baixa e média em PUSH/EMAIL esperam o fim da janela (local); crítica,
  alta e segurança saem na hora. A central mostra na hora.
- **Agrupamento** (RN-NOT-G-005): parciais da mesma ordem dentro de 5 s atualizam a mesma notificação
  (os valores do último evento, que são acumulados); ela só aparece e sai quando a janela fecha.
- **"Ocultar valores"** (RN-NOT-G-003): o push vira `Broker` + o texto genérico do código. O saldo
  negativo nunca vai para o push (template próprio do canal).
- **Destinatário**: o customer-service resolve conta, cliente, usuário ou solicitação em usuário e
  contato atual (`/v1/internal/notification-recipients`, token de serviço com
  `customer:notification-recipients`). O contato não é guardado aqui: é lido de novo a cada entrega.
  Evento sem destinatário (ex.: usuário do backoffice) é ignorado e registrado no log.

Eventos consumidos na Fase 1 (`startFrom: next`, sem bloquear a chave na DLQ, RN-MSG-B-035):

| Tópico            | Eventos                                                             | Código                                             |
| ----------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| `ledger.events`   | `deposit.credited` / `deposit.refunded`                             | `DEPOSIT_CREDITED` / `DEPOSIT_REFUNDED`            |
|                   | `withdrawal.completed` / `withdrawal.failed`, `withdrawal.rejected` | `WITHDRAWAL_COMPLETED` / `WITHDRAWAL_FAILED`       |
|                   | `ledger.negative_balance_detected`                                  | `NEGATIVE_BALANCE`                                 |
| `customer.events` | `account.status_changed`                                            | `ACCOUNT_STATUS_CHANGED`                           |
|                   | `suitability.expiring` / `suitability.expired`                      | `SUITABILITY_EXPIRING` / `SUITABILITY_EXPIRED`     |
|                   | `onboarding.submitted` / `.approved` / `.rejected`                  | `ONBOARDING_SUBMITTED` / `_APPROVED` / `_REJECTED` |
| `identity.events` | `identity.new_device_detected`                                      | `SECURITY_NEW_DEVICE`                              |
|                   | `identity.password_changed`, `identity.trading_signature_changed`   | `SECURITY_PASSWORD_CHANGED`                        |

Ordens, alertas, margem, proventos, notas, DARF e BTC já estão no catálogo; os consumidores chegam
com os serviços de origem (grupo 31 e seguintes). `SUITABILITY_EXPIRED` é uma extensão do catálogo
(o documento só lista o aviso de 30 dias). Preferências e "ocultar valores" ficam em
`notification_settings`, e não em `notification_preference.quiet_hours` como no modelo de dados.

A entrega é "pelo menos uma vez": se a instância cair entre o envio e o registro, a reserva vence e
a mensagem sai de novo (o message-sink não deduplica; o e-mail repete o mesmo `Message-ID`).

## Runbook

| Situação                                        | O que fazer                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nada chega e o log tem `RECIPIENT_UNAVAILABLE`  | O customer-service está fora ou o cliente OAuth `notification-service` não existe: cadastre-o (`POST /v1/admin/clients`, escopo `customer:notification-recipients`) e ponha o segredo em `NOTIFICATION_SERVICE_CLIENT_SECRET`. |
| E-mail não aparece no Mailpit                   | Veja `notification_delivery` (`status`, `last_error`, `next_attempt_at`): `PENDING` com data futura é silêncio ou backoff.                                                                                                     |
| `notification.failed` com `UNREGISTERED_DEVICE` | O aparelho saiu do provedor; o próximo registro do app (`POST /v1/me/push-devices`) reativa o token.                                                                                                                           |
| Texto errado num template                       | Grave uma versão nova por migração (`version + 1`, `valid_from` no futuro); a antiga continua valendo até lá.                                                                                                                  |
| Testar falha de push ou SMS                     | `POST /admin/scenarios` no message-sink (`PUSH_UNREGISTERED` ou `SMS_FAILURE`).                                                                                                                                                |
