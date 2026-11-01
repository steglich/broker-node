# market-maker-service

O Formador de Mercado Simulado (FMS, Motor §6, catálogo de serviços §10): cota compra e venda em torno
do preço de referência, para os clientes sempre terem contraparte e o preço interno seguir o mercado
real. Líder único com réplica em espera: só o líder roda a manutenção e o relay da outbox; os
consumidores são SAC, e a linha de `smm_state` serializa tudo o que mexe num instrumento.

API em `contracts/generated/openapi/market-maker-service.json`; eventos em `market-maker.events`;
ordens em `engine.commands`.

- **Cotações** (`domain/quotes.ts`, Motor §6.3): meio-spread, passo, inclinação por inventário e
  quantidade por nível, com compra arredondada para baixo e venda para cima. Testes de propriedade
  garantem `bid_1 < ask_1`, preços positivos e dentro do túnel (RN-SMM-002). O nível fora do túnel some,
  em vez de empilhar na borda. O fracionário tem um nível por lado, de `lot_size − 1`, só no contínuo.
- **Inventário** (RN-SMM-001/021): `inventory` é relativo ao estoque inicial, então `±inv_max` é
  exatamente "estoque em dobro" e "estoque zerado". Além de parar de cotar no limite, a soma das ofertas
  de cada lado cabe no que falta até ele: nem todas executadas levam o inventário além. O limite também
  não passa do estoque emitido, mesmo que o parâmetro suba depois da ativação.
- **Recotação** (RN-SMM-010/011): referência além do limiar, nível totalmente executado, mudança de
  fase e manutenção a cada `smm_refresh_interval`. Sempre cancelamento seguido de ordem nova, na mesma
  partição, então a oferta velha sai do livro antes da nova entrar e o FMS não cruza consigo mesmo.
- **Varredura** (RN-SMM-012): `smm_book_level` é a cópia do livro principal por `engine.book_changed`,
  e dela sai o que é de cliente (descontadas as ofertas do FMS). Com cruzamento, uma ordem `IOC` no melhor
  preço da cotação compra ou vende até `smm_max_sweep_lots`, e nenhuma cotação em repouso fica cruzando a
  sobra. A execução da varredura não dispara recotação: se disparasse, o limite "por recotação" não
  limitaria nada.
- **Fases** (Motor §6.6): `PRE_TRADING` calcula sem enviar; pré-abertura, leilão por volatilidade e call
  de fechamento têm um nível por lado em `ref ± meio_spread`; o contínuo cota completo; `HALTED`,
  `POST_CLOSE` e `CLOSED` cancelam tudo. A fase efetiva é a mais restritiva entre mercado e instrumento
  (RN-SES-001), como na sessão.
- **Defasagem** (RN-SMM-032): quem declara é o Market Data (`market_data.instrument_stale`, RN-BRP-070).
  Do instante da declaração, o spread dobra a cada hora: ×2, ×4, ×8. Na 4ª hora o FMS cancela tudo e para
  (`smm.status_changed` com `STOPPED`). Só uma cotação externa mais nova encerra a defasagem: o glide e o
  ruído continuam saindo sem a brapi.
- **Estoque** (RN-SMM-020): ao entrar no universo pela primeira vez, sai `smm.instrument_activated` com
  `limite × lote`. A custódia ainda não existe: na Fase 3 ela lê este evento desde o início e registra
  `ISSUER_SECURITIES` → `SMM_SECURITIES` como movimento retroativo. O tópico guarda 365 dias por isso.
- **Conta** (RN-SMM-022): `SMM_ACCOUNT_ID`, com `participantType = MARKET_MAKER`. As ordens vão direto
  ao Motor, sem Risco, custos nem IR. A liquidação no Clearing (D+2) vem na Fase 3.
- **Kill switch** (RN-SMM-030, Backoffice §3): por instrumento ou global. Desligar é imediato; religar e
  mudar parâmetros passam por dupla aprovação local (`smm_change_request`, `BO_MARKET` → `BO_ADMIN`). Na
  Fase 3 a decisão vem de `approval.request_approved`.
- **Métricas** (RN-SMM-031): `smm.metrics` a cada manutenção, com inventário, P&L realizado (custo médio)
  e a mercado, volume, recotações, spread efetivo e tempo cotado. O painel é `GET /v1/bo/smm/{id}`. Os
  contadores são acumulados desde a ativação. O trade bust refaz a posição pelas pontas em `smm_fill`.

## Premissas registradas

- **Recotar só o que mudou**: RN-SMM-011 fala em cancelar e criar. O nível idêntico ao desejado fica no
  livro, porque reenviá-lo só geraria comandos e perderia a prioridade sem mudar a cotação. A manutenção
  sem diferença não manda nada ao Motor.
- **`arredonda_lote`** (Motor §6.3) não diz o sentido: é para baixo, com mínimo de um lote, então o nível 3
  padrão tem 22 lotes (22,5 no cálculo).
- **"Depois para de cotar"** (RN-SMM-032) não diz quando: é quando o próximo degrau seria ×16, na 4ª hora.
- **`max_quote_staleness`**: RN-INS-020 usa 2 dias úteis para suspender, e RN-BRP-070 usa 45 min para
  declarar defasada. Com 2 dias o instrumento já estaria suspenso e o alargamento nunca apareceria, então
  o FMS segue a declaração de RN-BRP-070, como ela mesma pede.
- **Túnel**: o Motor não publica o túnel, e o catálogo não tem evento para ele. O FMS lê
  `engine.band_update` de `engine.commands`, o mesmo comando que o Motor recebe, e acompanha
  `engine.auction_completed`, que move a referência dentro do Motor (RN-INS-040).
- **Spread**: `smm_spread_bps` aparece em `instrument_trading_rules` (Ativos §7) e em `smm_parameters`
  (Catálogo §10). O dono é o reference-data: chega por `instrument.trading_rules_changed`, e o `PUT` do
  FMS não aceita esse campo.
- **`AFTER_MARKET`** não está na tabela do Motor §6.6 e fica desativada (Pregão §4.1): o FMS não cota.
- **Livro vs. FMS**: Motor §3 isenta o FMS do STP, mas o código do Motor o aplica a qualquer conta igual.
  Como o FMS nunca cruza consigo mesmo, isso não aparece aqui; a política enviada é `CANCEL_AGGRESSOR`.
- **Corrida da varredura**: a cópia do livro é eventual, então uma oferta de cliente que chegou depois da
  última leitura pode ser executada além do limite, sempre dentro do tamanho da ordem.
