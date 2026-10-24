# kyc-simulator — provedor de KYC simulado

Terceiro simulado (Sistemas simulados §3, Onboarding §5). `POST /v1/checks` responde `202` com
`check_id`; depois de `KYC_RESULT_DELAY_MS` (padrão 2–10 s) os documentos são lidos pelas URLs
pré-assinadas, analisados em memória e os resultados saem por webhook: um
`check.verification_completed` por verificação e um `check.completed` no fim.

Regra pelo penúltimo dígito do CPF: 0–6 aprova tudo; 7 → `FACE_MATCH` 50–79; 8 → `WATCHLIST`; 9 →
`TAX_ID_STATUS` irregular. `@broker/testing` gera CPFs válidos com o dígito desejado (`generateCpf`).

- UI: https://kyc.broker.localhost/ui (verificações, resultados, webhooks, falhas, resultados forçados).
- Não guarda documentos (RN-KYCS-001): recusa URL sem assinatura e apaga as referências ao concluir.

## Runbook

| Situação                                       | O que fazer                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `DOCUMENT_QUALITY` com `REFERENCE_UNAVAILABLE` | A URL expirou antes da análise: gere URLs com validade maior que `KYC_RESULT_DELAY_MS`.  |
| Forçar um resultado                            | UI → "Cenários forçáveis" ou `POST /admin/scenarios {"scenario":"FORCE_WATCHLIST_HIT"}`. |
| Exercitar retentativas do núcleo               | `PUT /admin/behavior {"transientErrorRate":0.5}` (RN-ONB-021).                           |
