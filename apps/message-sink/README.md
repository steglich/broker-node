# message-sink — caixa de SMS e push

Substitui a operadora de SMS e o serviço de push (RN-MSG-001/002): `POST /v1/sms` e `POST /v1/push`
registram a mensagem com o status de entrega (RN-MSG-003), consultável em `GET /v1/messages/:id`.
Nada sai para um telefone ou aparelho real.

E-mail não passa por aqui: vai por SMTP para o Mailpit (`mailpit:1025`), que guarda tudo e só repassa
a um SMTP real os destinatários de `MAIL_RELAY_ALLOWLIST` (veja `infra/README.md`). A configuração é
verificada por `test/mailpit-allowlist.test.ts`.

- UI: https://sms.broker.localhost/ui. E-mails: https://mail.broker.localhost.

## Runbook

| Situação                        | O que fazer                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Testar falha de entrega         | `POST /admin/scenarios {"scenario":"PUSH_UNREGISTERED"}` ou `SMS_FAILURE`.                                                                 |
| E-mail não chegou na caixa real | Confira se o destinatário bate com a regex de `MAIL_RELAY_ALLOWLIST` e se `MAIL_RELAY_HOST` está definido; a mensagem continua no Mailpit. |
