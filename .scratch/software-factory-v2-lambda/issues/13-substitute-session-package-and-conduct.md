# 13: Sessão substituta: pacote e conduta

**What to build:** A perda encerra a Execução. A sessão substituta entra pela fila como nova Execução, consome uma retomada operacional do orçamento
existente e recebe instrução explícita de recuperação. Na prova, a substituta não presumiu o que sumiu, mas não concluiu a fase; aqui a
conduta é imposta: concluir, publicar e perguntar sobre o efeito incerto. A reconciliação é uma Pergunta comum do MVP, sem mecanismo
novo.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-10, V2-18, V2-19 (gate obrigatório: a prova reprovou a ausência disto, P2).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 12

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Depois de uma perda, o Trabalho volta à fila; a nova Execução consome uma retomada operacional. Sem retomada disponível, vale a regra de orçamento do MVP.
- [x] O pacote da substituta traz: Trabalho, Execução, boots com motivo, último commit confirmado, a perda declarada, os efeitos de resultado incerto registrados pelo Controle, o consumo acumulado e a ref de marcador de perda, se existir, para aproveitar em vez de refazer. Sem transcript nem resumo da sessão anterior.
- [ ] A substituta nunca repete um efeito de resultado incerto.
- [ ] A substituta conclui o que não depende do efeito incerto.
- [x] Se o restante depende dele, abre uma Pergunta descrevendo o efeito e o registro do Controle; a resposta autoriza repetir ou dar por feito.
- [x] O gate de preservação precede o fim de toda ativação da substituta: ela publica o que fez antes de devolver o controle.
- [x] Cenário integrado sobre o fake: perda com efeito incerto registrado; a substituta conclui, publica e pergunta (os três pontos do gate obrigatório), e a resposta à Pergunta leva o Trabalho adiante.

## Answer

### O que foi construído

Num sandbox que não declara disco persistente, a Execução que volta pela fila depois de uma perda (`execution.interruption` apontando para
uma Execução que tem registro em `work.losses[]`) é a **sessão substituta**. Com disco persistente (Gondolin) nada muda. Nenhuma chamada
AWS, MicroVM, `ssh`/`websocat` ou modelo foram usados.

- **Fila e orçamento (V2-10).** Nada novo: a perda termina a Execução com código transitório, `applyConfirmedCessation` abre UMA retomada
  operacional com a espera persistida, e a admissão reserva e consome a unidade. Sem unidade, `RECOVERY_LIMIT_REACHED` (regra do MVP).
- **Pacote (V2-18)**, regra pura `substitutePackage` em `src/control/rules/substitute.ts`, montado por `substituteInstruction` em
  `src/control/durable/dispatch.ts`. O prompt da substituta é: o aviso fixo do ticket 08 e, no lugar do `interruptionRecoveryPrompt`, o pacote:
  Trabalho, Execução, Execução perdida, a perda declarada (boot, instante, motivo), o último commit confirmado (`loss.confirmed`), a ref de
  marcador (`present` com o comando de `fetch` para aproveitar; `absent`; `unknown`), os boots com motivo de início e fim, os efeitos de
  resultado incerto, o consumo acumulado (Execuções, tempo de Execução medido, segundos de boot na unidade do sandbox, retomadas consumidas)
  e a conduta. Os boots e os segundos vêm de `ports.sandbox.usage` (ticket 14); sem essa porta, dos registros do Controle, com consumo
  "unknown". Antes de montar, o Controle lê `ports.sandbox.channelReport` do boot PERDIDO e grava com `recordChannelReport` (pendência do
  ticket 11). Os efeitos listados são os da Execução perdida e os das Execuções com fim `failure` imediatamente anteriores
  (`substituteEffects`), no máximo 20. Textos vindos do guest ou do serviço entram como dado: uma linha, sem caracteres de controle nem crases.
- **Sem transcript nem resumo da sessão anterior.** O pacote não recebe nada da sessão: nem referência ao arquivo, nem o contexto de
  revisão preservado (`preservedReviewContext` é omitido para a substituta). Exceção declarada: quando o Trabalho tem Perguntas respondidas,
  o bloco `stateSummary` (ticket 48/53) continua indo, porque é registro do Controle (rodadas, gates e respostas aceitas), não da sessão, e
  sem ele uma resposta já dada seria pedida de novo.
- **Decisão 3D.** Com `started.artifacts.lost` não vazio, o pacote diz as últimas versões que o Controle registrou (`substituteVersions`:
  a maior versão de `spec` e de `instructions` citada em qualquer rodada de revisão do Trabalho) e manda preservar o pedido de novo com o
  número seguinte. Sem versão registrada, manda numerar depois da maior presente em `/artifacts`.
- **Gate antes do fim de toda ativação da substituta (V2-05 item 3).** `preservationGate('substitute-end')` no fim `question` e no fim
  `completed`; num fim `failure` com o ambiente vivo, UMA checagem (`checkPreservation`), sem laço de correção (quem corrigiria é o que falhou):
  aceita grava o commit confirmado; recusada vira perda registrada sob o código da própria falha.

### As quatro regras da conduta (V2-19): o que é mecanismo e o que é só prompt

1. **Nunca repetir um efeito incerto: só prompt.** O que o Controle impõe é o insumo: a lista vem do registro dele (relatório do canal do
   boot perdido), não da memória de sessão alguma, e a sessão antiga nunca é continuada (`sessionDecision` → `ENVIRONMENT_LOST`). Nenhum
   mecanismo impede a substituta de rodar o mesmo comando: o Host do Builder não compara chamadas com a lista.
2. **Concluir o que não depende dele: só prompt.** O Controle não observa se a fase foi concluída; o fim `completed` segue as verificações
   de sempre (rodadas, publicação). É exatamente o ponto que a prova reprovou (P2) e ele continua dependendo do modelo.
3. **Perguntar quando o resto depende: prompt para decidir perguntar; mecanismo depois.** A Pergunta é a comum do MVP (`ask_user`, registro,
   impedimento, resposta, retomada). O Controle não obriga a perguntar nem confere se a Pergunta descreve o efeito e o registro.
4. **Publicar antes de devolver o controle: mecanismo.** O gate recusa, devolve a recusa ao Builder no mesmo boot e só o commit publicado
   deixa a ativação terminar; três recusas encerram o boot como perda (decisão 7, abaixo).

### Decisão 7 do Operador (2026-11-21): três recusas do gate, V2-07 emendado

Não há mais `hold` à espera do Operador. `preservationGate` devolve `accepted` | `lost` | `stale`; em `lost`, `endAsLoss` (dispatch) grava
`execution.environmentEnd` com o motivo (`gateLossReason`: ocasião e diagnóstico da última recusa), termina a Execução como `failure` /
`PRESERVATION_GATE_REFUSED` (agora em `transient`), pede o Parar com motivo `loss`, retira as credenciais DEPOIS do Parar, grava a perda
(`LossRecord.cause = 'preservation-gate-refused'`) e libera o Slot. A substituta volta pela fila consumindo uma retomada. No adapter Lambda,
o Parar com motivo `loss` fecha o dono do boot sem desarmar o holder do marcador (`close({ keepMarker })`, `src/sandbox/lambda/owner.ts`,
`src/sandbox/index.ts`), para o hook de término empurrar o `HEAD` commitado como melhor esforço; esse Parar ainda coleta `/artifacts` pelo
canal, então as versões do pedido não se perdem nesse caminho. Num fim `question`, a Pergunta do Builder continua registrada e pendente: a
substituta só começa depois da resposta, que vai no bloco de Perguntas respondidas. Spec (V2-07 e linha da matriz), tickets 07 e 16 emendados.

### Decisão 8 do Operador (2026-11-21): divergência na retomada, V2-11 emendado

Regras em `src/control/rules/origin-divergence.ts` e `boot-notice.ts`; commits em `src/control/durable/origin-divergence.ts`; registro em
`work.originDivergence` (`OriginDivergenceView`). Tudo é decidido antes de qualquer boot.

- **Histórico reescrito:** `followRewrittenHistory`. A Execução que encontrou a reescrita é liberada antes do início e o Trabalho volta como
  UMA retomada operacional (`origin-history-rewritten:<confirmado>-><ponta>`); a Execução seguinte, já cobrada como `recovery`, inicia o boot
  na ponta nova, com sessão substituta (`sessionDecision` → `ORIGIN_HISTORY_REWRITTEN`) e o aviso `HISTORY CHANGED` com as duas refs. Sem
  Pergunta. A ponta seguida entra nos heads conhecidos da descoberta de publicação (senão a publicação seguinte bloquearia com
  `REMOTE_BRANCH_UNKNOWN_CHANGE`).
- **Branch ausente:** `settleBranchAbsent` abre uma Pergunta comum (`recordedFrom: 'controller-divergence'`, impedimento `QUESTION_PENDING`).
  Resposta exata `restart`: recomeça da ponta da base, sessão substituta (`ORIGIN_BRANCH_ABSENT`), aviso `BRANCH GONE`, sem consumir
  retomada, e a base de revisão passa a ser a do recomeço. Resposta exata `end`: cancelamento comum (`acceptCancel`). Outra resposta não
  decide nada e a Pergunta é feita de novo.
- `PRESERVED_BRANCH_CHANGED` continua bloqueando com `RECOVERY_CONTEXT_INSUFFICIENT` (não é assunto da decisão).

### Testes

`test/control/substitute-rules.test.ts` (pacote, conduta, 3D, dados), `test/control/substitute-flow.test.ts` (Controle real: o cenário
obrigatório e o orçamento esgotado), `test/entrypoints/lambda-substitute-composed.test.ts` (o cenário obrigatório sobre a composição de
PRODUÇÃO, a conta fake e o guest em processo: perda com chamada em voo → pacote → conclui → gate devolve o commit não publicado → publica →
Pergunta pelo relay → resposta → boot novo no commit publicado), `test/control/preservation-gate-flow.test.ts` e `loss-flow.test.ts`
(decisão 7), `test/control/boot-resume-flow.test.ts` e `boot-notice-rules`/`preservation-rules` (decisão 8 e textos).

### Critérios não marcados e formas não provadas

- **"A substituta nunca repete um efeito de resultado incerto" e "conclui o que não depende do efeito incerto": NÃO marcados.** São conduta
  do modelo; aqui existe o texto fixo e o insumo, não um mecanismo. Nos cenários, quem "não repete" e "conclui" é um agente roteirizado
  (dublê não comprova fronteira substituída). O gate obrigatório da spec (P2) só fecha com modelo real, na campanha do ticket 16.
- "Abre uma Pergunta descrevendo o efeito e o registro": marcado pelo mecanismo da Pergunta e pelo ciclo resposta → retomada; o CONTEÚDO da
  Pergunta é do modelo e não foi observado.
- Nada rodou em guest, conta ou GitHub reais. O hook de término empurrar o marcador num Parar pedido (holder mantido armado) depende de o
  serviço chamar o hook e esperar por ele num `TerminateMicrovm`; não há cenário disso, nem teste do `keepMarker` no nível do adapter.
- `git fetch` da ref de marcador pelo Builder no guest (com o token do canal) nunca rodou.
- Não foi red-green estrito: regra e teste do pacote nasceram juntos e passaram de primeira; os fluxos tiveram vermelho real (roteiro do
  dublê, a ponta seguida bloqueando a publicação).

### Limites e mudanças não pedidas

- A perda continua sendo gravada só no caminho vivo do despacho (limite do ticket 12): depois de queda do controlador a Execução seguinte
  recebe o `interruptionRecoveryPrompt` com o aviso, não o pacote.
- Ativação da substituta encerrada por timeout, cancelamento, entrega ou parada do dono não passa pelo gate (não há Builder para corrigir).
- Três recusas depois de uma publicação já feita no mesmo boot (fim `completed`) também viram perda e retomada: a substituta encontra o
  trabalho publicado. Antes era um hold.
- O bloco de Perguntas respondidas (`stateSummary`) vai junto do pacote quando há respostas: leitura do implementador de "sem resumo da
  sessão anterior" (é registro do Controle). Se o Operador quiser o pacote sem ele, é uma linha em `activationPlan`.
- **Não pedido:** a base de revisão de uma Execução sem disco passou a considerar também a Execução imediatamente anterior
  (`work.execution`), não só `previousExecutions`: sem isso a segunda Execução de um Trabalho pegava a ponta atual da base e a retomada
  bloqueava com `GIT_CONTEXT_CHANGED` se a base tivesse andado. `Script` `ask` dos dublês ganhou `during`; o dublê grava o motivo do Parar.
- "Encerrar o Trabalho" pela resposta usa `acceptCancel` com `origin: 'local-cli'` e `request_id` `origin-branch-absent-<pergunta>`: o
  histórico mostra um cancelamento local, não um evento próprio.

### O que os tickets seguintes precisam saber

- **09 (troca planejada):** `preservationGate('planned-swap')` devolve `lost` (não mais `held`) depois de três recusas e deixa o diagnóstico em
  `gateLoss`; quem chama decide o fim. Para o caminho de perda de V2-13, chamar `endAsLoss(gateRefusedCode)`.
- **16 (aceite):** conferir com modelo real os dois critérios não marcados, o marcador empurrado num Parar com motivo `loss`, e os dois
  ramos da decisão 8 num repositório real (force-push e exclusão da branch durante uma espera).

`npm run test:ci` (2026-11-21, depois do merge da ponta de `integration/software-factory-v2-lambda` com a correção de autonomia, decisões 5 e
6): 2098 testes, 2076 passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base:
`test/sandbox/audited-vfs-guard.test.ts` (4) e `test/sandbox/sandbox-adapter-diagnostics.test.ts` (1). No merge, o ramo de falha por canal
irrecuperável (decisão 6) ficou com o registro de perda da correção de autonomia; a checagem única da substituta não roda nesse caso.

## Comments

**2026-11-21 — Passe de correções da revisão final (branch `implement/v2-lambda-review-fixes`).**
- O pacote da substituta agora segue TODA perda (inclusive as que o Controle declara ao encerrar um boot e a da reconciliação depois
  de crash, itens 10 e 18 da revisão), com o texto da causa (`ended-unpublished`, `not-inspected`).
- Ponto 4 da conduta nomeia o push exato que o Host aceita (política `wip` na ativação de trabalho); antes o Host recusava esse push.
- Registro de canal ilegível: o pacote diz que não pôde ser lido, nunca "nenhum efeito registrado" (ver ticket 11).
- **Should-fix 13:** a resposta "end" à Pergunta de branch ausente registra a origem verdadeira (evento `cancel-requested` com origem
  `controller-dispatch` e "answer of Question <id>", impedimento "Ended by the accepted answer to Question <id>"), não `local-cli`.
