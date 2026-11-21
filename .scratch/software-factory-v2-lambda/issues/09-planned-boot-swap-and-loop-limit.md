# 09: Troca planejada de boot e limite contra laço

**What to build:** Uma Execução mais longa que a duração máxima do boot continua em outro boot sem perder identidade. Ao cruzar a margem, o Controle não
interrompe a chamada em curso; quando ela retorna, entrega o aviso de troca como ativação própria: o Builder publica o WIP, o gate aceita,
a cessação é confirmada e só então outro boot é iniciado. A troca mantém Trabalho, Execução, Slot, relógio de timeout e sessão; muda só
a referência de boot. Dois boots seguidos sem commit novo publicado geram Bloqueio em vez de um terceiro boot.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-10, V2-12, V2-13, V2-14.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 08

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Duração máxima (padrão 3600 s) e margem (padrão 600 s) vêm do perfil do adapter, lidas pelo Controle como capacidade; a duração do boot é limite distinto do timeout da Execução.
- [x] Ao cruzar a margem com chamada em curso, o Controle espera o retorno e então entrega o aviso de troca como ativação própria.
- [x] Sequência imposta: WIP publicado, gate aceito, cessação confirmada, novo boot iniciado; nunca dois boots do mesmo Trabalho ao mesmo tempo.
- [x] Se a chamada não retornar até restar metade da margem, o adapter a interrompe e pede o WIP com o tempo que sobra.
- [x] Se o gate não aceitar antes do fim do boot, vale o caminho de perda (registrado como tal; o tratamento completo é dos tickets 12 e 13).
- [x] A troca planejada mantém Trabalho, Execução, Slot, relógio de timeout e sessão, não consome retomada operacional e registra o boot com motivo "troca planejada".
- [x] Dois boots seguidos do mesmo Trabalho encerrados sem nenhum commit novo publicado entre eles geram Bloqueio com o diagnóstico "sem progresso entre boots", em vez de um terceiro boot.
- [x] Testes com relógio falso, sem `sleep`; a troca sob margem real e o boot acima de uma hora ficam para o aceite (ticket 16).

## Answer

### O que foi construído

Num sandbox que declara duração de boot e não declara disco persistente, uma Execução mais longa que o boot continua em outro boot sem
mudar de identidade, e dois boots seguidos sem commit novo publicado bloqueiam o Trabalho. Com disco persistente ou sem `bootDuration`
(Gondolin) nada roda: o relógio de boot não é armado e a Execução tem uma única ativação, como antes. Nenhuma chamada AWS, MicroVM,
`ssh`/`websocat` ou modelo; relógio falso em todos os testes.

- **Regras puras** (`src/control/rules/boot-rotation.ts`, `test/control/boot-rotation-rules.test.ts`): `bootSchedule(capacidade)` dá os três
  instantes do boot (margem = máx − margem; interrupção = metade da margem; fim = máx) ou `null` quando a capacidade é ausente;
  `swapNoticePrompt`/`swapContinuationPrompt` (textos fixos); `rememberBoot`, `bootLoopDecision`, `noProgressImpediment` (V2-14).
- **Relógio do boot no Controle** (`armBootClock` em `execute`, `src/control/durable/dispatch.ts`): lê só `capabilities.bootDuration`,
  conta a partir do pedido de Iniciar no relógio monotônico (`ports.clock`) e é rearmado a cada boot. É outro relógio: o timeout da
  Execução (`armTimeout`) não é tocado e continua correndo pela troca (cenário com timeout de 4000 s: troca aos 3000 s, timeout aos 4000 s).
- **Cruzar a margem** não interrompe nada: o Controle entrega a diretiva `boot-swap` ao Builder que trabalha (`workers.deliver`). O Host do
  worker (`src/workers/worker-session.ts`) deixa a chamada em curso retornar, não inicia outra chamada nem outro pedido de modelo e encerra
  a ativação com o status novo `boot-swap` e a sessão preservada (mesmo molde do fim após `ask_user`). Sessão suspensa em handoff de
  revisão só cede depois que os resultados chegam.
- **Sequência imposta** (`plannedSwap` em `execute`): aviso de troca como ativação PRÓPRIA (`builder-swap-notice`, invocação gravada antes
  do lançamento, política de push `wip`, sem handoff) → `preservationGate('planned-swap')` aceito → `sandbox.stop(reason: 'planned-swap')`
  com cessação confirmada → registro do boot e decisão do V2-14 → leitura do `origin` (`originContinuity`) → `sandbox.start(reason:
  'planned-swap')` na ponta → mesma sessão continuada (`builder-continuation`) começando pelo `newBootNotice` de ticket 08. O Iniciar só é
  pedido depois do Parar confirmado; sem confirmação a Execução fica em hold `BOOT_SWAP_CESSATION_UNCONFIRMED` e nenhum boot novo existe (o
  adapter Lambda ainda recusa por conta própria com `PREVIOUS_BOOT_NOT_CEASED`).
- **O aviso vai para a sessão que trabalha.** Era a dúvida do ticket: é viável. A ativação que cede termina com `session`; o aviso é uma
  ativação com `continuation: { session }` no boot velho, e a ativação do boot novo continua a sessão que o aviso devolveu. As correções de
  uma recusa do gate continuam indo à sessão `builder-preservation` do ticket 07 (o laço do gate não mudou). Se a ativação que cedeu não
  trouxer sessão observável, o aviso não é entregue, o gate decide do mesmo jeito e, aceito, a Execução termina com
  `BOOT_SWAP_SESSION_NOT_PRESERVED` (transitório: uma substituta volta pela fila).
- **Metade da margem:** se o Builder ainda não cedeu, o Controle pede `ports.sandbox.interruptCalls({ environment, boot, invocationId })`.
  No adapter Lambda (`src/sandbox/lambda/tools.ts`, `LambdaTools.interruptCalls`) a conexão da chamada é fechada, o grupo de processos é
  encerrado por conexão nova (`endCallProgram`, do ticket 11) e a chamada responde "indeterminado" (`orphan-ended`, efeito incerto gravado);
  o vínculo e o boot seguem. O Builder então cede e o aviso diz que a chamada foi interrompida e quantos segundos sobram. O aviso de troca
  em si nunca é interrompido.
- **Fim do boot sem gate aceito = perda.** Na duração máxima o relógio do Controle encerra a ativação pelo ramo de ambiente encerrado do
  ticket 10: `execution.environmentEnd` (`reason: 'BOOT_DURATION_REACHED'` quando foi o relógio do Controle; o motivo do serviço quando o
  vigia do adapter viu antes), fim `failure`/`SANDBOX_ENVIRONMENT_ENDED`, `swaps[].outcome.status = 'lost'`, boot no registro com fim `loss`,
  o registro de perda do ticket 12 e uma retomada operacional (V2-10).
- **Identidade (V2-10):** mesma Execução, mesmo Slot (nunca liberado), mesmo relógio, nenhuma admissão, zero retomadas. Mudam
  `execution.dispatch.boot` e `execution.invocationId` (passa a ser a ativação que continua a sessão; Perguntas e recibos são correlacionados
  com ela). Cada troca fica em `execution.swaps[]` (boot de origem, invocação que cedeu, chamada interrompida ou não, ativação do aviso,
  ativação de continuação, desfecho com commit e boot novo); `sessionBoot` e `bootNotice` são regravados no commit que precede o lançamento.
  Os números de rodada de revisão continuam depois dos já usados pela Execução.
- **V2-14** (`work.bootLedger`, `recordBootEnd` em `src/control/durable/boot-swap.ts`): cada boot encerrado entra no registro do TRABALHO
  (atravessa Execuções) com motivo de início e de fim e a ponta da branch no `origin` lida pelo próprio Controle no início e no fim. Dois
  últimos boots encerrados por troca ou por perda, ambos com a ponta parada, geram no mesmo commit o impedimento
  `NO_PROGRESS_BETWEEN_BOOTS` ("No progress between boots (sem progresso entre boots)") e nenhum terceiro boot é iniciado; na troca a Execução
  termina com esse código e o Slot é liberado, sem retomada.
- **Recorte do adapter e dos Workers:** `start` da porta do Controle ganhou `reason`; `createSandbox().interruptCalls`; `WorkerDirective`
  ganhou `{ kind: 'boot-swap' }` e `WorkerCompletion` o status `boot-swap` (esquemas do IPC, do launch e do dono atualizados); prompt de
  sistema de produção `builderSwapNotice` para a fase `builder-swap-notice`.

### Decisões tomadas aqui (para conferir)

- **Boots que contam para o V2-14:** só os encerrados por troca planejada ou por perda. Um boot encerrado por devolução ordinária de
  controle (Pergunta ou fim `completed` com gate aceito, falha com tratamento próprio, timeout) NÃO conta e QUEBRA a sequência: quem
  devolve o controle para uma espera externa depende de um evento de fora, não é laço automático, e uma Pergunta sem commit novo seguida de
  um reparo sem commit bloquearia um Trabalho saudável. Ponta ilegível não prova nada: o boot não conta.
- **"Chamada em curso" = chamada de ferramenta.** Um pedido de modelo em andamento termina; o Builder cede antes da chamada ou do pedido
  seguinte. Uma chamada que ainda não tinha começado é recusada sem efeito ("NOT EXECUTED") e a sessão a repete depois.
- **Troca que não consegue continuar** (sessão não preservada, `origin` não contínuo ou ilegível, Iniciar recusado): a Execução termina com
  um código transitório (`BOOT_SWAP_SESSION_NOT_PRESERVED`, `BOOT_SWAP_ORIGIN_NOT_CONTINUOUS`, `BOOT_SWAP_START_REFUSED`) e volta pela fila
  como retomada operacional, onde o Preparar do ticket 08 decide de novo (inclusive o bloqueio por divergência). Isso CONSOME uma retomada,
  também na recusa por quota do serviço: a decisão 5 do Operador (espera automática sem consumo) vale para o início de uma Execução e não
  foi estendida ao meio dela. Iniciar com resultado indeterminado deixa hold `BOOT_SWAP_START_<código>`.
- O ferramental do aviso de troca difere do da sessão de trabalho (sem `handoff`), para que um handoff no aviso não suspenda o Builder com o
  boot acabando. O Controle não chama `workers.observe` dentro da troca: a sessão acabou de ser devolvida pelo próprio dono do boot.

### Formas não provadas e limites

- **Nada composto.** Não há cenário de troca na composição de produção (Controle + adapter Lambda + dono do boot + fachada de Workers +
  conta fake): `composeProductionExecution` não tem como injetar o relógio monotônico do Controle. Cada costura foi testada sozinha: fluxo do
  Controle com dublês de sandbox/workers (`test/control/boot-swap-flow.test.ts`), sessão real do SDK com provedor offline cedendo e sendo
  continuada por outro worker (`test/workers/session-boot-swap.test.ts`), diretiva e conclusão pelo dono do boot
  (`test/sandbox/owner-handoff.test.ts`), interrupção no adapter com o guest em processo (`test/sandbox/lambda-environment-death.test.ts`).
  O trecho `workers.deliver` da fachada para o dono não tem teste próprio para `boot-swap`.
- Troca sob margem real, chamada realmente interrompida num guest e boot acima de uma hora: ticket 16. O relógio do Controle conta do pedido
  de Iniciar; a vida da MicroVM conta do `RunMicrovm`: os dois não foram comparados numa conta.
- Não foi red-green estrito no fluxo: os cinco cenários passaram na primeira execução. Sensibilidade conferida por mutação (retirar o
  bloqueio do V2-14, o pedido de interrupção e o fim pelo relógio do boot): os três cenários correspondentes falharam.
- Um pedido de troca que não chega ao Builder (worker ainda sem recibo de início, canal sem resposta) é repetido na metade da margem; só
  uma chamada realmente cortada é dita ao Builder como interrompida.
- Builder que cede logo ao voltar de uma revisão: o worker cede antes do pedido de modelo que levaria os resultados. Que o SDK grava essa
  mensagem na sessão antes do pedido não foi verificado (o teste do worker cobre o caso da chamada de ferramenta em curso).
- **V2-14 entre Execuções** (duas perdas seguidas, cada uma numa Execução): coberto pela regra pura e pelo registro por Trabalho; o cenário
  de fluxo só tem a primeira perda (a segunda exigiria a espera de retomada no calendário).
- Boot cuja morte ninguém registrou em vida (crash do controlador, reconciliação de boot do ticket 15) não entra em `work.bootLedger`.
- **Três recusas do gate na troca (decisão 7, depois do merge do ticket 13):** `preservationGate('planned-swap')` devolve `lost` e a troca
  chama `endAsLoss(gateRefusedCode)`: boot encerrado como perda, `work.losses[]`, `swaps[].outcome = 'lost'`, boot no registro do V2-14 e
  substituta pela fila. `endAsLoss` e o fim por canal irrecuperável passaram a chamar `noteBootEnd('loss')`, então TODA perda entra no
  registro do V2-14. O fim do boot pelo relógio usa o ramo de ambiente encerrado, cujo registro de perda é o do ticket 12.
- Builder suspenso em revisão quando a margem é cruzada: a rodada segue; se os resultados chegarem a tempo ele cede em seguida, senão o
  boot acaba e vale a perda. Na metade da margem só a chamada do Builder é interrompida, nunca a de um revisor. As fases depois da
  ativação de trabalho (publicação no boot, gate do fim) não são trocadas: se passarem da duração, é perda.
- `NO_PROGRESS_BETWEEN_BOOTS` não tem saída do Operador além de cancelar e abrir novo ciclo (`factory new`); não foi criado comando novo.
- A sessão interrompida por falha crítica ou por orçamento esgotado enquanto a troca estava pendente termina como antes (falha), não
  como `boot-swap`.

### O que os tickets seguintes precisam saber

- **Quem criar outro caminho de perda:** chamar `noteBootEnd('loss', código)` (em `execute`) antes do `recordEnd`, para o boot entrar no
  registro do V2-14 e uma troca aberta fechar como `lost`.
- **13:** `execution.swaps[]` diz em que boot a sessão estava e se uma chamada foi interrompida; `execution.invocationId` é a ÚLTIMA
  ativação de trabalho da Execução, as anteriores estão em `swaps[].yieldedInvocationId`.
- **14:** nada a fazer; o boot da troca é iniciado com `reason: 'planned-swap'` e parado com `planned-swap`.
- **16 (aceite):** o código do bloqueio é `NO_PROGRESS_BETWEEN_BOOTS`; os eventos no histórico são `boot-swap-due`, `boot-swap-notice`,
  `boot-swapped`, `boot-swap-ended`, `boot-ended` e `boot-loop-blocked`.

`npm run test:ci` (2026-11-21, depois do merge da ponta de `integration/software-factory-v2-lambda` com os tickets 12 e 13): 2119 testes,
2097 passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e
`test/sandbox/sandbox-adapter-diagnostics.test.ts` (1). Numa execução anterior, sob carga (595 s de 600 s), `test/entrypoints/journey-composed.test.ts`
estourou o orçamento à espera de `merge-blocked`; sozinho passou em 10,6 s e não falhou nas outras duas execuções completas.

## Comments

**2026-11-21 — Passe de correções da revisão final (branch `implement/v2-lambda-review-fixes`).**
- **Should-fix 5 (decisão 5 na troca):** recusa por quota ao iniciar o boot novo da troca não encerra mais a Execução
  (`BOOT_SWAP_START_REFUSED` transitório consumia uma retomada): a Execução espera 15 s, 60 s, 300 s e tenta de novo, mantendo sessão e
  Slot, com a causa em `swaps[].startWait` e no evento `boot-deferred`. Outras recusas definitivas seguem como antes.
- **Should-fix 10 (V2-14):** `NO_PROGRESS_BETWEEN_BOOTS` ganhou saída do Operador pelo `factory resume <trabalho>` genérico: retira o
  impedimento, zera `bootLedger` e devolve o Trabalho à fila como uma retomada operacional. O texto do impedimento nomeia o comando.
- **Must-fix 1:** boots encerrados pelo próprio Controle com trabalho não publicado, e boots que ficaram para trás num crash do
  controlador, entram no ledger como `loss` (item 26 da revisão).
- **Should-fix 9 (troca nas fronteiras de fase) NÃO foi feito: exige redesenho.** Motivos, por fronteira:
  1. *Antes de uma rodada de revisão:* o Builder está suspenso DENTRO da chamada `handoff`, e a ativação de trabalho continua viva. A
     troca de hoje só começa quando essa ativação termina com `boot-swap` e devolve a sessão. Encerrar um handoff suspenso como
     `boot-swap` não existe no Host dos Workers (seria uma diretiva nova), e a rodada já registrada (`recordHandoff`, estado
     `reviewing`, identidade H1 e captura `/artifacts/review/r<N>`, que é por boot pela decisão 3D) teria de ser descartada e
     recapturada no boot novo: estado novo de rodada e numeração, no Controle e no Host.
  2. *Antes da publicação no mesmo boot:* a decisão 1A.2 manda publicar no MESMO boot que verificou, e a verificação está presa à
     captura final e à identidade observada neste guest. Trocar antes exigiria levar a verificação para outro boot ou verificar de
     novo, que é a Execução de publicação separada que a decisão 1A eliminou neste perfil. Mudaria um contrato decidido.
  3. *Antes do gate de fim:* o gate já É a preservação; uma troca não acrescenta nada. O que resta é a correção estourar o boot, e aí
     vale o caminho de perda (decisão 7), agora com registro e substituta em todos os casos (must-fix 1).
  Enquanto isso, o que passa da margem nessas fases termina em `BOOT_DURATION_REACHED` como perda registrada. Fica para decisão do
  Operador se a diretiva nova no Host e o descarte de rodada valem o custo.
