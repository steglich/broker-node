# Spec Delta

## Purpose

Conduz uma pessoa de visitante a cliente com conta de investimento ativa (cadastro, KYC simulado, suitability, termos e aprovação) e mantém o cadastro, as contas de saque e o status da conta ao longo do tempo.

## ADDED Requirements

### Requirement: Etapas do onboarding
O onboarding SHALL seguir os estados `STARTED`, `CONTACT_VERIFIED`, `PERSONAL_DATA`, `ADDRESS`, `FINANCIAL_PROFILE`, `DOCUMENTS`, `SUITABILITY`, `TERMS`, `UNDER_REVIEW` e os desfechos `APPROVED`, `MANUAL_REVIEW`, `PENDING_CUSTOMER`, `REJECTED`, salvando cada etapa como rascunho retomável de qualquer canal (RN-ONB-001, Onboarding §3).

#### Scenario: Retomada em outro canal
- **WHEN** o cliente conclui a etapa de endereço no web e abre o mobile
- **THEN** o onboarding continua na etapa `FINANCIAL_PROFILE` com os dados já salvos

### Requirement: Expiração do onboarding
Uma solicitação parada por 30 dias SHALL expirar (`EXPIRED`) e os documentos SHALL ser descartados conforme a retenção (RN-ONB-002).

#### Scenario: 30 dias sem atividade
- **WHEN** a rotina diária encontra uma solicitação sem atividade há 30 dias
- **THEN** a solicitação passa a `EXPIRED` e novas ações nela retornam `ONBOARDING_EXPIRED`

### Requirement: Unicidade por CPF
O mesmo CPF SHALL NOT ter duas solicitações ativas nem duas contas não encerradas (RN-ONB-004).

#### Scenario: CPF já em uso
- **WHEN** alguém inicia um onboarding com CPF que já tem conta ativa
- **THEN** a resposta é `422` com `TAX_ID_ALREADY_REGISTERED`

### Requirement: Validações cadastrais
Os dados pessoais SHALL seguir as validações de nome, CPF, idade entre 18 e 120 anos, e-mail único verificado, celular E.164 verificado por OTP, documento de identidade e endereço com UF da lista fechada (Onboarding §4.1, §4.2).

#### Scenario: Menor de idade
- **WHEN** a data de nascimento indica 17 anos na data de submissão
- **THEN** a etapa é recusada com `UNDERAGE`

### Requirement: Revisão manual forçada
PEP = Sim ou residência fiscal no exterior = Sim SHALL forçar `MANUAL_REVIEW`, independentemente do KYC (RN-ONB-010, RN-ONB-011).

#### Scenario: Cliente PEP
- **WHEN** um cliente PEP com KYC aprovado submete a solicitação
- **THEN** a solicitação vai para `MANUAL_REVIEW`

### Requirement: Documentos por URL assinada
Os documentos SHALL ser enviados direto ao storage por URL assinada, em JPEG, PNG ou PDF, com até 10 MB e resolução mínima de 800×600; o tipo SHALL ser verificado pelo conteúdo e o nome gerado pelo servidor (RN-API-002, Onboarding §5.1, Segurança de aplicação: upload).

#### Scenario: Arquivo grande demais
- **WHEN** o cliente envia um documento de 12 MB
- **THEN** o documento é recusado com `DOCUMENT_INVALID_FORMAT`

### Requirement: Decisão do KYC
O resultado do KYC SHALL ser registrado por verificação com payload bruto e resultado normalizado; `FACE_MATCH` ≥ 80 aprova, 50–79 manda para revisão manual e < 50 reprova, e as retentativas do provedor SHALL ser tratadas de forma idempotente pelo `check_id` (RN-ONB-020..022).

#### Scenario: Aprovação automática
- **WHEN** todas as verificações do KYC são aprovadas e não há PEP
- **THEN** a solicitação passa a `APPROVED` e são publicados `onboarding.approved`, `customer.created` e `account.opened`

#### Scenario: Webhook repetido
- **WHEN** o mesmo resultado de `check_id` chega duas vezes
- **THEN** a decisão é aplicada uma vez

### Requirement: Saga de abertura de conta
A abertura SHALL ser orquestrada pelo `customer-service` com estado persistido (KYC → aprovação → conta → contas do ledger por evento → perfil de risco por evento) e SHALL ser retomável após reinício (RN-PAD §5, RN-PAD-030).

#### Scenario: Reinício no meio da saga
- **WHEN** o serviço reinicia depois do KYC aprovado e antes de criar a conta
- **THEN** a saga é retomada e a conta é criada uma única vez

### Requirement: Número da conta
O número da conta SHALL ter o formato `NNNNNNN-D` (7 dígitos sequenciais e dígito verificador módulo 11), ser único e nunca reutilizado (RN-ACC-001).

#### Scenario: Dígito verificador
- **WHEN** a conta é criada
- **THEN** o dígito verificador do número confere pelo módulo 11

### Requirement: Status da conta e permissões
A conta SHALL seguir os estados `ACTIVE`, `RESTRICTED`, `BLOCKED`, `CLOSING` e `CLOSED` com a matriz de permissões de comprar, vender, depositar, sacar e logar, e toda mudança SHALL publicar `account.status_changed` com `reason_code` e ator (RN-ACC §7.2, RN-ACC-010).

#### Scenario: Conta restrita compra
- **WHEN** uma conta `RESTRICTED` tenta comprar
- **THEN** a ordem é rejeitada com `ACCOUNT_NOT_ACTIVE`

#### Scenario: Bloqueio cancela ordens
- **WHEN** a conta passa para `BLOCKED`
- **THEN** o evento publicado faz o OMS cancelar as ordens abertas com motivo `ACCOUNT_BLOCKED` (RN-ACC-011)

### Requirement: Encerramento da conta
O encerramento SHALL exigir posições zeradas, saldo zero, nenhum contrato de aluguel ativo, nenhuma liquidação pendente e nenhum DARF em aberto do mês corrente, e SHALL listar as pendências ao cliente (RN-ACC-012).

#### Scenario: Encerramento com saldo
- **WHEN** o cliente pede encerramento com R$ 50,00 de saldo
- **THEN** a resposta lista a pendência de saldo e a conta continua `ACTIVE`

### Requirement: Restrição por saldo devedor
O serviço SHALL passar a conta a `RESTRICTED` com motivo `NEGATIVE_BALANCE` ao consumir `ledger.negative_balance_detected` e SHALL remover a restrição ao consumir `ledger.negative_balance_cleared` (RN-DEV-002, RN-DEV-005).

#### Scenario: Saldo devedor coberto
- **WHEN** chega `ledger.negative_balance_cleared` para uma conta restrita só por esse motivo
- **THEN** a conta volta a `ACTIVE`

### Requirement: Suitability
O questionário SHALL ser versionado, com pesos por alternativa e faixas de pontuação parametrizáveis para `CONSERVATIVE`, `MODERATE` e `AGGRESSIVE`; a avaliação vale 24 meses, o cliente é avisado 30 dias antes e vale sempre a mais recente (RN-SUI-001..003, RN-SUI-012, RN-SUI-013).

#### Scenario: Perfil por pontuação
- **WHEN** o cliente soma 32 pontos com as faixas padrão
- **THEN** o perfil é `AGGRESSIVE` e `suitability.assessed` é publicado

#### Scenario: Suitability vencido
- **WHEN** passam 24 meses desde a última avaliação
- **THEN** `suitability.expired` é publicado e novas compras exigem refazer o questionário

### Requirement: Contas de saque
O cliente SHALL cadastrar até 3 contas/chaves PIX de saque de mesma titularidade (validada pela consulta de chave no simulador), com assinatura eletrônica, e cada conta nova SHALL ter carência de 24 h antes do primeiro uso (RN-ACC-020, RN-ACC-021).

#### Scenario: Chave de terceiro
- **WHEN** o cliente cadastra uma chave cujo titular tem outro CPF
- **THEN** o cadastro é recusado com `BANK_ACCOUNT_NOT_ALLOWED`

### Requirement: Manutenção cadastral
Alterações de e-mail, celular e endereço SHALL exigir reautenticação e OTP no canal antigo e no novo; alteração de nome ou documento SHALL passar por revisão manual; o histórico de alterações SHALL ser mantido; e cadastro vencido há 24 meses SHALL tornar a conta `RESTRICTED` (RN-CAD-001..004).

#### Scenario: Troca de nome
- **WHEN** o cliente envia um novo nome com documento
- **THEN** a alteração fica pendente de revisão manual e o histórico registra a versão anterior

### Requirement: Termos e consentimentos
Cada aceite SHALL registrar `terms_id`, `version`, `accepted_at`, `ip`, `user_agent`, `channel` e hash do conteúdo; uma nova versão de termo obrigatório SHALL deixar o cliente só com consulta até o novo aceite (RN-TER-001, RN-TER-002).

#### Scenario: Nova versão de termo
- **WHEN** é publicada uma nova versão do contrato de intermediação
- **THEN** ordens do cliente são rejeitadas com `TERMS_PENDING` até ele aceitar
