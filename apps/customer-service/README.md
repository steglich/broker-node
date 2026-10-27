# customer-service

Onboarding, cliente, conta de investimento, suitability, termos, contas de saque e manutenção
cadastral (catálogo de serviços §2, Contas e onboarding). Rotas em
`contracts/generated/openapi/customer-service.json`.

- **Onboarding** (`/v1/me/onboarding/*`): contato com OTP no e-mail e no celular, dados pessoais
  (18 a 120 anos, CPF único), endereço, perfil financeiro, documentos, suitability e termos. Cada etapa
  é um rascunho cifrado que o app retoma de qualquer canal. Submeter manda ao KYC simulado
  (`UNDER_REVIEW`).
- **Documentos**: `upload-url` devolve uma URL pré-assinada do bucket `documents` (nome do objeto
  gerado pelo servidor); `POST /documents` confere tamanho (10 MB), tipo pelos bytes (JPEG, PNG,
  PDF) e resolução (800×600).
- **KYC** (`POST /webhooks/kyc-simulator`, assinado): cada verificação vira `kyc_check` com o payload
  bruto; `check.completed` decide uma vez. Reprovação → `REJECTED`; atenção, PEP ou residência fiscal
  no exterior → `MANUAL_REVIEW`; tudo aprovado → `APPROVED`.
- **Abertura** (saga `account_opening`): cliente, conta `NNNNNNN-D` e os eventos `onboarding.approved`,
  `customer.created`, `account.opened` e `suitability.assessed` numa transação; depois, a conta no
  Banco Simulado. A retomada roda na subida e a cada 10 s.
- **Suitability e termos**: questionário versionado com pesos e faixas parametrizáveis, validade de
  24 meses; aceite com hash do conteúdo, IP, user agent e canal. Termo obrigatório novo → `TERMS_PENDING`.
- **Conta**: matriz de permissões por status, restrições (`NEGATIVE_BALANCE`, `REGISTRATION_EXPIRED`),
  bloqueio pelo backoffice e encerramento com as pendências dos donos (ledger, custódia, aluguel,
  liquidação, IR). Elegibilidade para os outros serviços: `GET /v1/internal/accounts/{id}/eligibility`.
- **Destinatário das notificações**: `GET /v1/internal/notification-recipients?accountId=|customerId=|userId=|applicationId=`
  (escopo `customer:notification-recipients`) devolve o usuário, a conta e o contato atual; antes da
  aprovação, o contato da solicitação. O e-mail e o celular não trafegam nos eventos (RN-MSG-B-013).
- **Contas de saque**: até 3 chaves PIX de mesma titularidade (consulta ao Banco Simulado), com
  assinatura eletrônica, MFA recente e carência de 24 h.
- **Cadastro**: e-mail, celular e endereço com assinatura e OTP no canal antigo e no novo; nome e
  documento por revisão manual; histórico append-only; vencido em 24 meses → `RESTRICTED`.
- **Rotina diária** `customer_daily` (22:00): expira solicitações paradas há 30 dias, avisa e vence
  o suitability e restringe cadastros vencidos.

## Runbook

| Situação                                 | O que fazer                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Aprovada sem conta                       | A retomada abre sozinha em até 10 s. Se não abrir, veja `saga_instance` (`saga_type = 'account_opening'`) e o log `opening.start_failed`. |
| Webhook do KYC recusado (401)            | Segredo diferente entre `webhook_kyc_simulator` e o serviço, ou relógios com mais de 5 min de diferença.                                  |
| Encerramento `CLOSURE_CHECK_UNAVAILABLE` | Falta algum dono em `CUSTOMER_CLOSURE_CHECK_URLS` (são cinco) ou um deles está fora. Por desenho, sem a resposta de todos, não encerra.   |
| Cliente preso em `MANUAL_REVIEW`         | Fila em `GET /v1/bo/onboarding/queue`; PEP só um `BO_ADMIN` aprova.                                                                       |
