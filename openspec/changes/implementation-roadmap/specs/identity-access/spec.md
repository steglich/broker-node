# Spec Delta

## Purpose

Gerencia identidade e acesso dos realms de clientes e de backoffice: credenciais, MFA, sessões, tokens, assinatura eletrônica para comandos sensíveis, papéis e recuperação de acesso.

## ADDED Requirements

### Requirement: Realms separados
O sistema SHALL manter os realms `customers` (cadastro self-service) e `backoffice` (sem cadastro self-service, MFA forte obrigatório) com usuários, sessões e políticas separados (Autenticação §1, RN-BO-002).

#### Scenario: Cadastro no backoffice
- **WHEN** alguém tenta se registrar sozinho no realm `backoffice`
- **THEN** a operação não existe e a resposta é `404`

### Requirement: Política de senha
A senha SHALL ter no mínimo 10 caracteres, ser verificada contra lista de senhas vazadas/comuns, não conter e-mail, nome ou CPF e ser armazenada com função de derivação lenta com sal; não há regra de composição forçada (RN-AUTH-001).

#### Scenario: Senha contendo o CPF
- **WHEN** o usuário cadastra uma senha que contém o próprio CPF
- **THEN** o cadastro é recusado com erro de validação no campo da senha

### Requirement: Bloqueio por tentativas
Após 5 falhas seguidas de login, o sistema SHALL aplicar atraso progressivo; após 10, SHALL bloquear por 30 min e enviar e-mail ao titular. Respostas de login SHALL NOT revelar se o e-mail existe (RN-AUTH-002).

#### Scenario: Décima falha
- **WHEN** ocorre a 10ª falha seguida de login de um usuário
- **THEN** o login fica bloqueado por 30 minutos e o titular recebe e-mail

#### Scenario: E-mail inexistente
- **WHEN** alguém tenta logar com um e-mail não cadastrado
- **THEN** a resposta é idêntica à de senha errada

### Requirement: MFA
O sistema SHALL suportar TOTP, WebAuthn e OTP por SMS simulado (só para recuperação). MFA SHALL ser obrigatório no backoffice e para operar alavancado ou sacar acima do limite configurado (RN-AUTH-003, Autenticação §1).

#### Scenario: Ativação de TOTP
- **WHEN** o usuário confirma um código TOTP válido na ativação
- **THEN** o fator fica ativo e `identity.mfa_enabled` é publicado

### Requirement: Tokens e sessões
O sistema SHALL emitir access token assinado (assimétrico, 10 min) com `sub`, `realm`, `account_id`, `roles`, `scope`, `session_id`, `amr`, `exp`, `iat`, `jti`, e refresh token opaco guardado como hash, com validade de 30 dias (web/desktop) ou 90 dias (mobile com biometria) e rotação a cada uso (Autenticação §4).

#### Scenario: Reuso de refresh token
- **WHEN** um refresh token já rotacionado é usado de novo
- **THEN** toda a família de tokens é revogada e a sessão é encerrada

### Requirement: Gestão de sessões
O usuário SHALL ver e revogar suas sessões ativas, e o login em dispositivo novo SHALL gerar `identity.new_device_detected` para a notificação `SECURITY_NEW_DEVICE` (RN-AUTH-013).

#### Scenario: Revogar outra sessão
- **WHEN** o usuário revoga uma sessão de outro dispositivo
- **THEN** os tokens daquela sessão deixam de ser aceitos e `identity.session_revoked` é publicado

### Requirement: Inatividade por canal
Sessões SHALL expirar por inatividade conforme o canal: web 30 min, desktop 2 h (configurável até 8 h), backoffice 15 min (RN-AUTH-012, RN-BO-003).

#### Scenario: Web inativa
- **WHEN** uma sessão web fica 31 minutos sem atividade
- **THEN** a renovação do token é recusada e o usuário precisa logar de novo

### Requirement: Assinatura eletrônica
O sistema SHALL manter um segredo de assinatura separado da senha (6 a 8 dígitos ou WebAuthn) e, ao validá-lo, emitir um token de assinatura de curta duração (5 min, ou até 8 h com "lembrar nesta sessão" para ordens) vinculado à sessão e ao escopo `ORDERS`, `WITHDRAWALS` ou `SETTINGS` (RN-SIG-001, RN-SIG-003).

#### Scenario: Token de assinatura de outro escopo
- **WHEN** um saque é enviado com um token de assinatura de escopo `ORDERS`
- **THEN** a resposta é `403` com `TRADING_SIGNATURE_REQUIRED`

### Requirement: Comandos que exigem assinatura
Enviar e alterar ordens, solicitar saque, cadastrar conta de saque, ativar margem, ofertas e contratos de BTC, pagar DARF com saldo e transferência de custódia SHALL exigir token de assinatura válido; cancelar ordem SHALL NOT exigir (RN-SIG-002, RN-SIG-005).

#### Scenario: Cancelamento sem assinatura
- **WHEN** o cliente cancela uma ordem sem token de assinatura
- **THEN** o cancelamento é aceito

### Requirement: Bloqueio da assinatura
Três erros de assinatura SHALL bloqueá-la por 30 min; seis erros SHALL bloqueá-la até redefinição com MFA (RN-SIG-004).

#### Scenario: Sexto erro
- **WHEN** o cliente erra a assinatura pela sexta vez
- **THEN** a assinatura fica bloqueada até redefinição com MFA

### Requirement: Step-up
Operações sensíveis (cadastrar conta de saque, desativar MFA, saque acima de R$ 10 mil) SHALL exigir `amr` com MFA nos últimos 15 minutos, além da assinatura (RN-AUTHZ-003).

#### Scenario: MFA antigo
- **WHEN** o cliente pede saque de R$ 15.000,00 com último MFA há 20 minutos
- **THEN** a resposta exige novo MFA antes de prosseguir

### Requirement: Recuperação de acesso
A recuperação SHALL usar link de uso único por e-mail (15 min) mais segundo fator; após a troca, todas as sessões SHALL ser revogadas e a assinatura eletrônica bloqueada por 24 h (RN-AUTH-004).

#### Scenario: Saque após recuperação
- **WHEN** o cliente recupera o acesso e tenta sacar 1 hora depois
- **THEN** a assinatura está bloqueada e o saque é recusado

### Requirement: Revogação por bloqueio de conta
Ao consumir `account.status_changed` para `BLOCKED`, o serviço SHALL revogar os tokens de assinatura do usuário (RN-AUTH-014, Catálogo §1).

#### Scenario: Conta bloqueada
- **WHEN** a conta do cliente passa a `BLOCKED`
- **THEN** os tokens de assinatura ativos daquele usuário são invalidados

### Requirement: RBAC do backoffice com segregação
Usuários do backoffice SHALL ter papéis (`BO_ONBOARDING`, `BO_FINANCE`, `BO_MARKET`, `BO_RISK`, `BO_SUPPORT`, `BO_ADMIN`, `BO_AUDITOR`), e `BO_AUDITOR` SHALL NOT acumular outro papel (RN-BO-001, Backoffice §2).

#### Scenario: Auditor com outro papel
- **WHEN** um admin tenta atribuir `BO_FINANCE` a um usuário `BO_AUDITOR`
- **THEN** a operação é recusada por segregação de funções

### Requirement: Identidade de serviço
Chamadas internas SHALL usar identidade de serviço com escopos mínimos (ex.: `risk:pretrade`), e um serviço sem o escopo SHALL ser recusado (Autenticação §5.1, RN-API-050).

#### Scenario: Serviço sem escopo
- **WHEN** um serviço sem `risk:pretrade` chama o pré-trade
- **THEN** a chamada é recusada com `403`
