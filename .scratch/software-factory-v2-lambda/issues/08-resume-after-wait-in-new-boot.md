# 08: Retomada após espera em novo boot

**What to build:** Respondida a Pergunta (ou terminada a espera de CI ou prontidão), o Trabalho retoma num boot novo, reconstruído do Git remoto e da
declaração de ambiente, com a mesma sessão quando a continuidade é compatível. Toda ativação em um boot diferente do último que a sessão
viu começa com um aviso fixo do Controle.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-11; MVP §5.5, §10.1.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 07

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] A retomada inicia um boot novo a partir da ponta da branch no `origin`; nada do boot anterior é adotado.
- [x] A primeira ativação num boot diferente do último que a sessão viu começa com o aviso fixo: ambiente recriado, commit de partida, e que arquivos ignorados, caches e dados do Docker não existem mais.
- [x] A mesma sessão continua quando a ponta da branch no `origin` é o commit confirmado pelo gate ou descende dele; o aviso lista os commits novos.
- [x] Retomada com commits de terceiros sobre o commit confirmado: mesma sessão, commits listados no aviso (gate de validação da spec, não provado no protótipo).
- [x] Histórico reescrito: o Controle segue o remoto com uma sessão substituta que recebe o aviso de que o histórico mudou, consumindo uma retomada operacional, sem Pergunta. Branch ausente: Pergunta comum, recomeçar da base ou encerrar o Trabalho. (Decisão do Operador em 2026-11-21, V2-11 emendado; antes: "segue a regra de divergência do MVP, sem regra nova". Implementado no ticket 13, que substitui o bloqueio descrito abaixo.)
- [x] Ativações seguintes no mesmo boot não repetem o aviso.
- [x] A retomada após espera não consome retomada operacional.

## Answer

### O que foi construído

Num sandbox que não declara disco persistente, a retomada (Pergunta respondida, reparo depois de CI/prontidão, mudança de escopo) deixa de
bloquear com `RECOVERY_CONTEXT_INSUFFICIENT`/`PREVIOUS_ENVIRONMENT_NOT_REUSED`: a continuidade passa a ser um fato do `origin`, lido pelo
próprio Controle, e o primeiro prompt do boot novo começa com o aviso fixo. Com disco persistente (Gondolin) nada muda: os textos do MVP são
os mesmos byte a byte e `recoveryContext` continua exigindo o checkout reutilizado. Nenhuma chamada AWS, MicroVM, `ssh`/`websocat` ou modelo.

- **Regra pura** (`src/control/rules/boot-notice.ts`, testes em `test/control/boot-notice-rules.test.ts`):
  - `originContinuity({ preserved, branch, origin, comparison })`: `continuous` (a ponta É `work.preservation.commit` ou descende dele; devolve
    `startCommit` e os commits novos), `unconfirmed` (nenhum gate confirmou nada), `divergent` (`ORIGIN_HISTORY_REWRITTEN`,
    `ORIGIN_BRANCH_ABSENT`, `PRESERVED_BRANCH_CHANGED`) ou `unknown` (`ORIGIN_COMPARISON_NOT_READ`).
  - **O seam único do aviso:** `bootNoticeDue({ lastSeen, boot })` + `lastSessionBoot(executions)`. "Último boot que a sessão viu" é
    `execution.sessionBoot`, gravado em `confirmActivation` (o boot da ativação da sessão do Builder); registros antigos caem no boot da
    Execução com início confirmado. Primeiro boot do Trabalho (`lastSeen` nulo) não tem aviso.
  - `newBootNotice(...)`: o texto fixo (ambiente recriado, commit de partida, ignorados/pacotes/caches/Docker não existem mais, commits novos
    desde o commit confirmado, o que foi restaurado em `/artifacts` e o que se perdeu, e que `review/r<N>` e cópias de saída não voltam).
    Assuntos e autores de commit são dados: uma linha, sem caracteres de controle nem crases, no máximo 30 commits.
  - `recreatedContext`/`withNotice`/`preservationClaim`: os cinco prompts de retomada (`continuationPrompt`, `recoveryPrompt`,
    `interruptionRecoveryPrompt`, `reconciliationPrompt`, `publicationPrompt`) aceitam `recreated`; com ele começam pelo aviso e trocam a
    frase "workspace … e /artifacts foram preservados" por uma que aponta para o aviso.
- **Controle** (`src/control/durable/dispatch.ts`, ramo `diskless` do Preparar): `readOrigin(work, branch, compareFrom)` pede ao GitHub a
  comparação `commit confirmado...ponta` quando diferem. `continuous` inicia o boot na ponta; `unknown` não inicia nada e devolve o Trabalho à
  fila (`releaseBeforeStart`, sem consumo); `divergent` bloqueia ANTES de qualquer boot (`blockBeforeStart`, código
  `RECOVERY_CONTEXT_INSUFFICIENT`, próximo passo com o motivo, a ponta atual e o commit confirmado). O plano de ativação recebe
  `recreated: { continuity, notice }` (tipo `Prepared`) e o repassa a `recoveryContext` e aos prompts. A Execução grava `sessionBoot` e
  `bootNotice` (`boot`, `previousBoot`, `startCommit`, `confirmed`, nº de commits, restaurados, perdido) no commit da intenção de ativação.
- **Decisão 3D no adapter Lambda** (`src/sandbox/lambda/artifacts.ts`, `boot.ts`): `restoreLambdaArtifacts` reenvia só `spec/` e
  `instructions/` com o mesmo programa fixo de escrita dos seeds; `previousLambdaArtifacts` escolhe a origem andando pelos boots anteriores
  do ambiente, do mais novo: o primeiro `preserved` é a fonte, `absent` encerra sem nada a enviar, e um boot que acabou antes da coleta entra
  em `lost` (boot que nunca ficou ativo é ignorado). `StartResult.artifacts = { restored, from, lost }` (ausente no primeiro boot e no
  Gondolin) e `boot.json.restored`. Reenvio que falha falha o Iniciar (`ARTIFACT_RESTORE_FAILED`, MicroVM encerrada): nunca um boot que
  silenciosamente não tem o pedido.
- **Verificação de fim de Execução:** as referências de fonte preservada de rodadas herdadas (`/artifacts/spec|instructions/v<N>/…`) são
  lidas no boot novo sobre o que foi reenviado; coberto no nível do adapter (programa real com `python3` local e boot com o guest fake).

Testes: `test/control/boot-notice-rules.test.ts`, `test/control/boot-resume-flow.test.ts` (Controle real, sandbox sem disco: Pergunta
respondida → boot novo na ponta, mesma sessão, aviso, sem aviso na ativação seguinte do mesmo boot, zero retomada operacional; commits de
terceiros; histórico reescrito; branch ausente; comparação ilegível), `test/sandbox/lambda-artifacts.test.ts` e `test/sandbox/lambda-boot.test.ts` (3D).

### Critério não marcado: divergência

"Histórico reescrito ou branch ausente segue a regra de divergência do MVP" está atendido só em parte. O que existe: nada é iniciado de outro
commit, nenhum Builder é ativado, nada é escrito e o Trabalho fica bloqueado com as refs conhecida e atual para decisão explícita (a metade
"impede a próxima escrita e apresenta" de §10.1), usando o bloqueio que já existia, sem código novo. O que NÃO existe: a Pergunta de
divergência com `incorporate`/`discard`. No MVP ela só nasce na descoberta de publicação (`decideDiscovery`), que não roda entre uma espera
e a retomada, e sua proposta parte de um "resultado local" preservado, que neste perfil não existe. Levar essa Pergunta para a retomada
muda o contrato (o que se propõe quando não há resultado local): precisa de decisão do Operador.

### Formas não provadas

- Nada rodou num guest real. O reenvio 3D manda cada árvore inteira num único stdin (teto de 64 MiB/8192 arquivos, o mesmo da coleta).
- A continuação da MESMA sessão entre boots só foi exercitada com o dublê de workers (`observe` devolve `compatible`). Na composição de
  produção a sessão é lida no host por `ref` (`readSessionFile`), fora do guest; isso não passou pela jornada composta, que não tem Pergunta
  nem arquivo de sessão real. A jornada composta (`lambda-journey-composed`) não ganhou cenário de retomada.
- Retomada com commits de terceiros: provada com o dublê do GitHub (comparação `ahead`), não com um repositório real (gate de validação da spec).
- Critério 6 ("ativações seguintes no mesmo boot"): hoje uma Execução tem uma ativação da sessão de implementação; o que se observa é que a
  publicação no mesmo boot não recebe aviso e que `bootNoticeDue` é falso para o mesmo boot. Várias ativações da MESMA sessão num boot são do ticket 09.
- Execuções de publicação e de reconciliação separadas neste perfil: o bloqueio foi levantado e o prompt diz a verdade, mas a reconciliação
  ainda fala em "resultado local" e nenhuma das duas tem cenário sem disco.
- Não foi red-green estrito nas regras e no adapter (escritos junto com os testes). Vermelho real: o fluxo mostrou que o `work` do despacho
  ainda traz a Execução anterior em `execution`, não em `previousExecutions` (o aviso não saía).

### O que os tickets seguintes precisam saber

- **09 (troca planejada):** depois de iniciar o boot novo na MESMA Execução, perguntar `bootNoticeDue({ lastSeen: lastSessionBoot([...anteriores, execution]), boot })`,
  montar o texto com `newBootNotice` (o `started.artifacts` do novo Iniciar traz o que foi reenviado) e, ao ativar, gravar
  `execution.sessionBoot = <boot novo>` (hoje só `confirmActivation` grava). `originContinuity` serve igual com o commit do gate `planned-swap`.
- **13 (substituta):** a base de interrupção passa por `recoveryContext` com `recreated.interruption`, então `unconfirmed` (nenhum gate
  aceito) é suficiente e o `interruptionRecoveryPrompt` já sai com o aviso, inclusive a linha `LOST` quando `started.artifacts.lost` não é
  vazio. Falta a conduta: numerar a nova versão do pedido depois da última registrada e o pacote da substituta.
- **12 (perda visível):** `boot.json.restored.lost` e `execution.bootNotice.lost` dizem quais boots perderam versões.
- Retomada sem commit confirmado (fim `question`/`completed` sem `work.preservation`) bloqueia com `PRESERVED_COMMIT_NOT_RECORDED`, depois do boot.

`npm run test:ci` (2026-11-21, depois do merge da ponta de `integration/software-factory-v2-lambda` com os tickets 12, 14 e 15): 2068 testes,
2046 passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e
`test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

### Emenda de 2026-11-21 (decisão do Operador, implementada no ticket 13)

A seção "Critério não marcado: divergência" e o bloqueio `RECOVERY_CONTEXT_INSUFFICIENT` com `ORIGIN_HISTORY_REWRITTEN` / `ORIGIN_BRANCH_ABSENT`
deixaram de valer neste perfil. Decisão 8 do Operador: histórico reescrito segue o remoto com sessão substituta, aviso de histórico alterado
e uma retomada operacional, sem Pergunta; branch ausente abre uma Pergunta comum (`restart` ou `end`). `PRESERVED_BRANCH_CHANGED` continua
bloqueando. Os dois cenários de bloqueio de `test/control/boot-resume-flow.test.ts` foram substituídos por três cenários da decisão. Seams e
limites no Answer do ticket 13.
