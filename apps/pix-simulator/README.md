# pix-simulator — Banco Simulado

Terceiro simulado (Sistemas simulados §2): contas, cobranças, envio de PIX, consulta de chave,
devolução e consulta de transação. Banco próprio (`pix_simulator`) e API documentada em
`contracts/generated/openapi/pix-simulator.json`, no estilo da API Pix do Banco Central.

- UI: https://bank.broker.localhost/ui (contas, cobranças com botão de pagar, PIX, webhooks, falhas).
- Webhook `pix.recebido` para `WEBHOOK_URL`, assinado com `secrets/webhook/pix_simulator` (RN-SIM-003)
  e reenviado com backoff até `2xx` (RN-SIM-004). Repetições têm o mesmo `X-Webhook-Id`.
- Na subida, cria a conta da corretora (`BROKER_CNPJ`, saldo `BROKER_INITIAL_BALANCE`) e duas contas de terceiros.

## Runbook

| Situação                        | O que fazer                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Webhooks parados em `PENDING`   | Veja `last_error` na UI; o receptor (`WEBHOOK_URL`) está fora ou responde ≠ `2xx`. A fila retoma sozinha.                              |
| Forçar um cenário (RN-PIXS-003) | UI → "Cenários forçáveis" ou `POST /admin/scenarios {"scenario":"KEY_NOT_FOUND"}`. Vale para a próxima operação.                       |
| Simular queda de 10 min         | UI → "Derrubar" ou `POST /admin/unavailability {"minutes":10}`; `DELETE /admin/unavailability` religa.                                 |
| Zerar o banco simulado          | `docker compose -f infra/compose/compose.yml exec postgres psql -U postgres -d pix_simulator` e apague as tabelas, ou recrie o volume. |
