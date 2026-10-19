# Spec Delta

## Purpose

Simula os terceiros que uma corretora real usaria (banco/PIX, provedor de KYC e entrega de e-mail, SMS e push) como serviços separados, com API própria, webhooks assinados e falhas configuráveis, para estudar integração de verdade.

## ADDED Requirements

### Requirement: Simuladores como serviços separados
Cada simulador SHALL ser um serviço separado, com banco e API próprios documentados como de terceiro, acessado pelo núcleo só por adaptador com ACL (RN-SIM-001).

#### Scenario: Modelo externo não vaza
- **WHEN** o ledger recebe um webhook do simulador PIX
- **THEN** os nomes de campo do simulador não aparecem em eventos, tabelas ou APIs do ledger

### Requirement: Comportamento configurável
Cada simulador SHALL permitir configurar por ambiente a latência (fixa ou por distribuição), a taxa de erro transitório (`5xx`/timeout), a taxa de erro definitivo e janelas de indisponibilidade programada (RN-SIM-002, RN-ONB-021).

#### Scenario: Taxa de erro transitório
- **WHEN** a taxa de erro transitório do KYC está em 50%
- **THEN** cerca de metade das submissões responde `5xx` e o núcleo tenta de novo

### Requirement: Webhooks assinados
Webhooks SHALL ser assinados com HMAC-SHA256 sobre `timestamp + "." + corpo`, nos headers `X-Signature` e `X-Timestamp`. O receptor SHALL rejeitar assinatura inválida ou desvio de timestamp maior que 5 minutos (RN-SIM-003, RN-DEP-008).

#### Scenario: Assinatura inválida
- **WHEN** o ledger recebe um webhook com assinatura que não confere
- **THEN** responde `401` e não aplica nenhum efeito

#### Scenario: Timestamp antigo
- **WHEN** o webhook chega com `X-Timestamp` de 6 minutos atrás
- **THEN** o receptor o rejeita

### Requirement: Entrega de webhook pelo menos uma vez
O simulador SHALL reenviar o webhook com backoff (1 s, 5 s, 30 s, 2 min, 10 min, 1 h) até receber `2xx` (RN-SIM-004).

#### Scenario: Receptor fora do ar
- **WHEN** o receptor responde `503` às duas primeiras tentativas
- **THEN** o simulador reenvia na terceira tentativa e para ao receber `2xx`

### Requirement: Contas do Banco Simulado
O simulador PIX SHALL criar, para cada cliente aprovado, uma conta com saldo inicial configurável (padrão R$ 10.000,00 em prod simulada e R$ 100.000,00 no sandbox), titularidade igual ao CPF e chave PIX. Também SHALL manter a conta da corretora e contas de terceiros para testes (Sistemas simulados §2.1).

#### Scenario: Cliente aprovado
- **WHEN** a conta de investimento de um cliente é aberta
- **THEN** existe no Banco Simulado uma conta com o CPF do cliente e o saldo inicial configurado

### Requirement: Operações PIX
O simulador PIX SHALL oferecer criar cobrança (`txid`, valor, expiração, payload copia-e-cola marcado como simulado), pagar cobrança escolhendo a conta pagadora, enviar PIX para chave, consultar titular de chave, devolver PIX e consultar transação por `txid` ou `end_to_end_id`, sempre com `end_to_end_id` único e com prefixo de simulação (Sistemas simulados §2.2, RN-PIXS-001).

#### Scenario: Pagamento por terceiro
- **WHEN** uma cobrança do cliente X é paga por uma conta de outro CPF
- **THEN** o webhook informa o CPF do pagador real, permitindo ao núcleo devolver o valor

#### Scenario: Consulta de chave
- **WHEN** o núcleo consulta uma chave PIX
- **THEN** recebe o CPF do titular e o nome mascarado

### Requirement: Cenários forçáveis do PIX
O simulador PIX SHALL permitir forçar pagamento duplicado, webhook atrasado após a expiração, chave inexistente no saque, indisponibilidade de 10 minutos e saldo insuficiente na conta da corretora (RN-PIXS-003).

#### Scenario: Webhook duplicado
- **WHEN** o cenário de pagamento duplicado está ativo
- **THEN** o mesmo webhook (mesmo `end_to_end_id`) é entregue duas vezes

### Requirement: KYC determinístico
O provedor de KYC SHALL aceitar a submissão com `202` e `check_id`, responder por webhook o resultado de cada verificação (`TAX_ID_STATUS`, `DOCUMENT_QUALITY`, `FACE_MATCH`, `WATCHLIST`, `LIVENESS`) e decidir pelo penúltimo dígito do CPF: 0–6 aprova tudo; 7 dá `FACE_MATCH` entre 50 e 79; 8 dá ocorrência em `WATCHLIST`; 9 dá `TAX_ID_STATUS` irregular (RN-ONB §5.2, Sistemas simulados §3).

#### Scenario: Penúltimo dígito 7
- **WHEN** um CPF com penúltimo dígito 7 é submetido
- **THEN** o webhook traz `FACE_MATCH` com score entre 50 e 79

#### Scenario: Penúltimo dígito 9
- **WHEN** um CPF com penúltimo dígito 9 é submetido
- **THEN** o webhook traz `TAX_ID_STATUS` irregular

### Requirement: KYC sem retenção de imagens
O provedor de KYC SHALL receber só referências temporárias e assinadas para os documentos no storage do núcleo, e SHALL NOT guardar as imagens além do necessário para responder (RN-KYCS-001).

#### Scenario: Referência expirada
- **WHEN** o simulador tenta ler um documento depois da validade da URL assinada
- **THEN** a leitura falha e nenhuma cópia local existe

### Requirement: Caixa de captura de mensagens
E-mail e SMS SHALL ir para uma caixa de captura com UI, e push SHALL ser registrado por um simulador no ambiente local. Nenhum ambiente SHALL enviar para destinatários reais fora de uma lista de permissão explícita (RN-MSG-001..003).

#### Scenario: Destinatário real
- **WHEN** uma notificação é endereçada a um e-mail fora da lista de permissão
- **THEN** a mensagem fica só na caixa de captura

### Requirement: UI de inspeção
Cada simulador SHALL ter uma UI mínima, servida por ele mesmo, para listar transações e forçar resultados (RN-SIM-005).

#### Scenario: Forçar falha de saque
- **WHEN** o operador marca na UI do simulador que o próximo PIX enviado falha
- **THEN** o próximo saque recebe falha definitiva
