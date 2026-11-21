# 14: Consumo por boot e por Trabalho; recusa por quota

**What to build:** O Operador vê quanto de MicroVM cada Trabalho consumiu, sem a Factory calcular dólares. Por boot: identidade, motivo, tamanho, início,
fim e segundos, a partir de `GetMicrovm`; builds de imagem por chave. Por Trabalho: MicroVM-segundos acumulados, sem reinício entre boots
ou Execuções. Recusa do serviço por quota ao iniciar é impedimento visível do início.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-30 (execução), V2-32.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 06

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Cada boot tem registrados identidade, motivo, tamanho, início, fim e segundos, com os tempos vindos de `GetMicrovm`.
- [x] Builds de imagem são registrados por chave de ambiente.
- [x] O Trabalho acumula MicroVM-segundos por todos os boots e Execuções, sem reinício; o acumulado aparece na observabilidade da CLI junto do consumo existente.
- [x] Não há valor nem teto em dólares; a documentação diz ao Operador como conferir o custo pela tag da instalação.
- [x] Recusa do serviço por quota ao iniciar um boot é impedimento visível do início, com a causa, e não consome retomada operacional.
- [x] Boot cuja observação final não foi possível registra o consumo como desconhecido, nunca como zero.

## Answer

O consumo é medido em MicroVM-segundos, por boot e acumulado por Trabalho, e a recusa por quota ao iniciar é impedimento bloqueante cujo
retry não consome retomada. Tudo sobre o fake da conta: nenhuma chamada AWS, nenhuma MicroVM, nenhum modelo.

- **Por boot (Sandbox).** `boot.json` ganhou `end.seconds` = `terminatedAt` − `startedAt` do `GetMicrovm` (`serviceSeconds` em
  `src/sandbox/lambda/boot.ts`); ausente quando o serviço não deu os dois instantes. `src/sandbox/lambda/usage.ts` traduz o registro para
  o contrato neutro `BootUsage` (`src/contracts/boot-usage.ts`): identidade, motivo de início e de fim, rótulo de tamanho, início, fim,
  segundos e `state`: `measured`, `running`, `unknown` (fim não confirmado, ou RunMicrovm sem resposta legível: `seconds` é `null`, nunca
  zero) e `not-run` (início recusado antes de existir MicroVM: 0). Leitura: `createSandbox().usage({ environment })`, só dos registros do
  host (não consulta a conta). Ambiente de outro adapter responde `unavailable`, nunca lista vazia.
- **Builds de imagem por chave.** `src/sandbox/lambda/image-ledger.ts`: `<raiz>/lambda/image-builds.jsonl`, uma linha por fato
  (`requested` quando ESTE Preparar pediu o build; `created`/`failed` quando qualquer Preparar leu o resultado). Leitura:
  `createSandbox().environmentBuilds()` (builds por chave, Trabalhos que usam a chave, último resultado). Retry de build falho conta como
  outro build da mesma chave. Falha ao gravar a linha não falha o Preparar (o build já foi pedido): nesse caso o build fica sem registro.
- **Por Trabalho (Controle).** Portas opcionais `ExecutionPorts.sandbox.usage` e `environmentBuilds`, compostas só quando o adapter é o
  Lambda (`composition.ts`); o Controle não aprende nada do serviço: soma os segundos e mostra a unidade e o rótulo como vieram.
  `bootConsumption` (regra pura em `rules/inspection.ts`) dobra os boots de todos os ambientes do Trabalho: só `measured` soma;
  `running`/`unknown` são contados à parte e marcam `lowerBound`; nada medido dá `seconds: null`. `factory usage [<trabalho>]` mostra
  `works[].boots` (junto de tokens, orçamento e tempo) e, no escopo da instalação, `environmentBuilds`. Sem a porta (Gondolin) a view fica
  byte a byte como era. O acumulado não reinicia entre boots nem Execuções porque o ambiente é do Trabalho, e sobrevive ao Remover.
- **Sem dólares.** Nenhum valor ou teto; `docs/lambda-installation.md` §7 diz como conferir o custo pela tag da instalação (cost
  allocation tags + Cost Explorer) e o que não foi conferido numa conta.
- **Recusa por quota (V2-30).** O adapter devolve `SERVICE_CAPACITY_REFUSED` (era `MICROVM_CAPACITY_REFUSED`: renomeado porque a regra
  ESLint proíbe o Controle de nomear `microvm`). No Controle, `START_SERVICE_CAPACITY_REFUSED` (`serviceCapacityCodes` em
  `rules/recovery.ts`) segue o caminho de recusa de início do ticket 50: nada iniciou, Slot e reserva liberados, impedimento
  `RECOVERY_BLOCKED` com texto próprio (causa do serviço, o que conferir, comando). O retry
  (`factory resume <trabalho> --retry-blocked-start START_SERVICE_CAPACITY_REFUSED`) só levanta o impedimento: não abre retomada
  operacional (`blockedStart.retry.recoveryRequest: 'not-required'`), e o Trabalho volta à fila com o motivo que tinha.

**Escolha de interpretação (para o Operador confirmar).** "Impedimento visível do início" foi lido como impedimento bloqueante com saída
explícita do Operador, não como a espera automática de capacidade do ticket 50 (15/60/300 s). Neste código todo impedimento fecha o
despacho do Trabalho, então "impedimento" e "nova tentativa automática" não coexistem sem um conceito novo. Se a intenção for tentar de novo
sozinho, a troca é pequena: pôr o código em `bootCapacityCodes` (a espera aparece como `BOOT_CAPACITY_WAIT` e no histórico, sem impedimento).

Formas não provadas:

- O nome do erro de quota do serviço (classificação `capacity` em `cli-service.ts`, do ticket 04) e se quota e falta de capacidade devem
  ter o mesmo tratamento: hoje têm.
- Se a cobrança da AWS atribui o uso de uma MicroVM às tags do `RunMicrovm`; o passo a passo da doc não foi executado numa conta.
- Por quanto tempo um `GetMicrovm` de MicroVM encerrada continua legível: boot que ficou `unknown` só vira `measured` se alguém observar
  ou parar de novo enquanto o serviço ainda responde.

Limites e pendências:

- `usage` não consulta o serviço: um boot `unknown` continua assim até um Observar/Parar posterior ler o fim (reconciliação: ticket 15).
- `factory status` (`ControlStatus.consumption`) e `factory show` não ganharam os segundos; só `factory usage`.
- Os boots não são correlacionados à Execução na view (o registro do boot não guarda a Execução); a lista é do Trabalho.
- A view mostra os 50 boots e as 50 chaves mais recentes (`omitted` conta o resto); a soma cobre todos.
- Não há cenário de recusa por quota na jornada composta: a recusa do adapter (`test/sandbox/lambda-usage.test.ts`,
  `lambda-boot.test.ts`) e o fluxo do Controle (`test/control/usage14-flow.test.ts`) são ligados pelo mesmo código literal.
- Não foi red-green estrito: os testes foram escritos antes do código, mas o primeiro run já foi verde; a sensibilidade foi conferida
  por mutação (código de quota fora da lista; `unknown` somado como medido), com 3 testes falhando como esperado.
- `docs/lambda-installation.md` §6 ainda diz que o controlador não executa Trabalhos sob o adapter (texto do ticket 04, defasado desde o
  06); não alterado aqui.

Testes: `test/sandbox/lambda-usage.test.ts`, `test/control/usage14-flow.test.ts`, bloco de consumo no fim de
`test/entrypoints/lambda-journey-composed.test.ts`.

`npm run test:ci` (2026-11-21, depois do merge da ponta de integração com os tickets 07 e 10): 2028 testes, 2006 passam, 17 pulados, 5 falham, resultado FAIL. As 5
falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e `test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

O que os tickets seguintes precisam saber:

- **09 (troca planejada):** cada boot da troca entra sozinho na soma; nada a fazer além de iniciar com `reason: 'planned-swap'`.
- **10/12 (perda):** boot observado `TERMINATED` sem Parar entra como `measured` com fim `loss`; boot cuja morte ninguém observou fica
  `running` na view até um Observar.
- **15 (reconciliação):** ao encerrar uma órfã por tag, gravar o fim pelo caminho de `observeLambdaBoot`/`stopLambdaBoot` preenche
  `end.seconds`; `image-builds.jsonl` não deve ser apagado pelo cleanup de imagens (é o histórico de builds por chave).
- **16 (aceite):** o código de recusa do Iniciar é `SERVICE_CAPACITY_REFUSED`.

## Comments

**2026-11-21 — Decisão 5 do Operador substitui a recusa por quota bloqueante (branch `implement/v2-lambda-fix-autonomy`).**
A recusa do serviço por quota ou capacidade ao iniciar deixou de ser impedimento: `START_SERVICE_CAPACITY_REFUSED` entrou em
`bootCapacityCodes` (`src/control/rules/recovery.ts`) e segue a espera de capacidade do ticket 50. Nada inicia, Slot e reserva são
liberados, nenhuma retomada operacional é aberta ou consumida e a Factory tenta de novo sozinha.

- **Espera, não laço.** `applyBootDeferral` grava `work.bootDeferral` com `notBefore`; o despacho recusa o Trabalho com
  `BOOT_CAPACITY_WAIT` até lá (`durable/execution.ts`). 15 s, 60 s, depois 300 s repetidos enquanto a recusa continuar; zera quando
  um boot inicia. O teste de fluxo confere que não há tentativa dentro da espera e que a segunda recusa espera 60 s.
- **Causa visível.** `bootDeferral.detail` (campo novo) e o evento `boot-deferred` trazem a causa devolvida pelo serviço, junto do código.
- **Removido.** `serviceCapacityCodes` / `isServiceCapacityRefusal`, o texto próprio em `blockedStartImpediment` e o valor
  `'not-required'` de `blockedStart.retry.recoveryRequest`. `factory resume --retry-blocked-start START_SERVICE_CAPACITY_REFUSED`
  responde `not-applied` / `RECOVERY_NOT_BLOCKED` (não há bloqueio); o comando genérico do ticket 50 continua para os outros códigos.
- **Não há teto de tentativas:** a espera repete a cada 300 s enquanto a quota faltar; a saída manual é `factory cancel`.
- Critério "impedimento visível do início" deste ticket e o texto da V2-30 passam a ser lidos como espera visível (nota na spec).
  `docs/lambda-installation.md` (seção da recusa por quota) atualizado.
- Testes: `test/control/usage14-flow.test.ts` (reescrito, vermelho antes da troca), `test/control/retry50-rules.test.ts`.

`npm run test:ci` (2026-11-21, branch `implement/v2-lambda-fix-autonomy`): 2089 testes, 2067 passam, 17 pulados, 5 falham, resultado FAIL. As 5
falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e `test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).
