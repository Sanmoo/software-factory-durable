# 11: Canal caído com ambiente vivo

**What to build:** Queda do canal sozinha não encerra a ativação. O adapter consulta o serviço; com o ambiente ativo, reconecta, encerra o grupo de
processos da chamada órfã e devolve à sessão o resultado "indeterminado", nunca "não executada". Não há reanexação à saída do processo
órfão.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-21, V2-22.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 05

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Canal caído com ambiente ativo: o adapter reconecta com as mesmas credenciais de transporte do boot e a host key fixada.
- [x] O grupo de processos da chamada que estava em curso é encerrado depois da reconexão (a prova mostrou que canal fechado não encerra o processo).
- [x] A chamada interrompida volta à sessão como "indeterminado", com texto que deixa claro que o efeito pode ter ocorrido; nunca como "não executada".
- [x] Não há reanexação à saída do processo órfão.
- [x] Canal caído com ambiente encerrado segue o caminho do ticket 10, não o de reconexão.
- [x] Efeitos de resultado indeterminado ficam registrados pelo Controle, para o pacote da substituta (ticket 13).
- [x] Reconexão que falha repetidamente com ambiente ativo tem limite e, sem laço, encerra o boot como perda registrada e o Trabalho volta sozinho num boot novo consumindo uma retomada operacional. (Redação corrigida em 2026-11-21 pela decisão 6 do Operador; antes: "vira impedimento visível".)

## Answer

Queda do canal com a MicroVM viva deixa de encerrar a ativação, sobre o fake da conta e o guest em processo. Nenhuma chamada AWS, nenhum
`ssh`/`websocat`, nenhuma MicroVM. Red-green estrito no primeiro corte do Sandbox (queda no Bash), nos três testes de Workers e no fluxo
do Controle; os demais testes do Sandbox (write/edit, limite, ambiente encerrado, host key) nasceram verdes sobre o laço já escrito e
tiveram a sensibilidade conferida por mutação (ambiente encerrado ignorado; limite sem trava: ambas detectadas).

- **Grupo de processos por chamada.** `toolScript(argv, cwd, call)` (`src/sandbox/lambda/tools.ts`) grava o PID do programa em
  `/tmp/factory-call-<uuid>` (o UUID é do host) antes do `exec`; `endCallProgram(call)` mata esse grupo por uma conexão NOVA, como o mesmo
  usuário Unix, e não lê nada do que o órfão escreveu (sem reanexação).
- **Recuperação** (`recovered`, mesmo arquivo; ligada por `serveLambdaTools`): conexão que cai (`lost`) ou não abre (`refused` /
  `UNREACHABLE`) sem o host tê-la fechado consulta o serviço (`observeLambdaBoot`). Ambiente encerrado: nada é reconectado, a perda fica
  gravada no registro do boot e a chamada segue o caminho antigo (códigos de efeito desconhecido, invocação revogada). Ambiente vivo:
  chamada que não começou é refeita; chamada que começou tem o grupo encerrado e volta como resultado sem status com
  `channel: 'orphan-ended'`. Mesmas credenciais do boot: o canal é o de `openChannel` (chave de sessão do boot, host key fixada; outra
  host key é recusada e conta como tentativa falha). Leitura do serviço que falha não vale como encerramento.
- **Limite:** `lambdaReconnect` = 5 tentativas com 5 s entre elas, no relógio do boot. Esgotado: a chamada responde efeito desconhecido,
  o boot grava `unrecoverable`, não serve mais nenhuma chamada (`bind` recusa `CHANNEL_UNRECOVERABLE`, inclusive em outro processo) e
  nenhuma chamada posterior consulta o serviço ou espera.
- **Resultado indeterminado.** `GuestOwner.result` ganhou `channel?: ChannelDropOutcome`. Bash, write e commit de edit respondem
  `BASH_RESULT_INDETERMINATE`, `WRITE_RESULT_INDETERMINATE`, `EDIT_SOURCE_RESULT_INDETERMINATE` sem revogar a invocação
  (`bash-tools.ts`, `write-tools.ts`). Em Workers (`src/workers/indeterminate.ts`, `bash.ts`, `write.ts`, `edit.ts`) esses três códigos
  deixam de ser críticos: a sessão recebe um erro de ferramenta com texto fixo ("RESULT INDETERMINATE ... its effects may have happened
  ... not confirmed as executed and not confirmed as not executed ... inspect") e continua. Só um sandbox que recupera canal emite esses
  códigos; o Gondolin não muda.
- **Registro.** Antes de a chamada responder, o host grava o efeito em `<boot>/channel.jsonl` (`recordLambdaChannelEntry`): Execução,
  invocação, papel, ferramenta, `callId`, descrição (comando Bash até 512 caracteres, ou operação e caminho) e desfecho (`orphan-ended`,
  `environment-ended`, `channel-unrecoverable`). Leitura por qualquer processo: `sandbox.channelReport({ environment, boot })`
  (`ChannelReport` em `src/contracts/channel-report.ts`).
- **Controle.** Capacidade nova e opcional `channelRecovery` (`SandboxCapabilities`; o Lambda declara, o Gondolin não). Com ela, o despacho
  lê `ports.sandbox.channelReport` antes de gravar o fim de uma falha e antes de todo Parar (`stopOwnBoot`), e grava em
  `execution.indeterminateEffects` (`recordChannelReport`, `src/control/durable/channel-report.ts`; regras em
  `src/control/rules/channel-report.ts`; limite de 64, idempotente por boot e `callId`). Canal irrecuperável: a Execução termina como
  `failure` / `SANDBOX_CHANNEL_UNRECOVERABLE` (não transitório: sem retomada automática) e o Trabalho ganha o impedimento de mesmo código.

Formas não provadas (nada rodou num guest real):

- **PID = grupo de processos.** Supõe que o `sshd` roda cada comando como líder de sessão e que o `exec` do bootstrap mantém o PID. Um
  comando que crie o próprio grupo ou sessão (`setsid`, job control, contêiner Docker) escapa do kill. PID reutilizado entre a queda e a
  reconexão mataria outro processo do mesmo usuário.
- **`endCallProgram`:** `kill -KILL -- -PID`, espera de até 5 s e conferência com `kill -0`; nunca rodou no Alpine do guest.
- **Chamada que cai antes de gravar o marcador** responde `call-not-started` e é tratada como órfão encerrado (resultado indeterminado).
- **Classificação `lost` x `UNREACHABLE`** continua sendo a do `classify` do ticket 04.

Limites e pendências:

- Leituras (revisor, captura do edit) e a cópia de saída do Bash não têm efeito a registrar e ficam no caminho antigo: a leitura do
  revisor falha como `GUEST_READ_FAILED` (a sessão segue); captura do edit e cópia de saída ainda encerram a sessão.
- Timeout e interrupção pelo host continuam fechando só a conexão: o órfão desses casos não é morto.
- **Impedimento sem saída própria.** `SANDBOX_CHANNEL_UNRECOVERABLE` só sai com `factory cancel`, como o `EXECUTION_TIMEOUT` do MVP. Se a
  decisão for retomar num boot novo, basta incluir o código em `transient` (`src/control/rules/recovery.ts`) e não gravar o impedimento.
- O texto do comando Bash vai ao registro do Controle sem passar pelo filtro de segredos dos Records.
- O relatório só é lido no caminho vivo do despacho. A reconciliação depois de queda do controlador (`src/control/durable/recovery.ts`)
  não o lê.
- A composição de produção ganhou só a linha `channelReport` em `src/entrypoints/controller/composition.ts`; o Lambda ainda não é
  composto (ticket 06).

Para os tickets seguintes:

- **06:** hospedar `sandbox.serveTools` (a recuperação já vem ligada) e passar `channelReport` nas portas do Lambda.
- **10:** o ponto de roteamento é `recovery.condition()` devolver `ended` em `serveLambdaTools`: hoje a chamada em voo responde efeito
  desconhecido e a perda é gravada pelo `observeLambdaBoot`. Falta negar chamadas novas e fazer o Controle encerrar a ativação. O vigia
  deve usar a mesma leitura do serviço e nunca reconectar.
- **13:** os efeitos incertos estão em `execution.indeterminateEffects` (na Execução corrente e em `previousExecutions`), tipo
  `IndeterminateEffectRecord` de `src/control/types.ts`. A reconciliação de perda deve chamar `recordChannelReport` com o relatório do
  boot perdido antes de montar o pacote; os de desfecho `environment-ended` são os da chamada em voo na hora da perda.

Testes: `test/sandbox/lambda-tools.test.ts` (quatro casos novos e o de perda estendido; fake em `lambda-guest-fake.ts`: processos,
`drop()`, `channelDown`, `end-call`), `test/workers/indeterminate-result.test.ts`, `test/control/channel-report-flow.test.ts`,
`test/control/channel-report-rules.test.ts`; ajuste em `lambda-profile.test.ts`.

## Comments

**2026-11-21 — Decisão 6 do Operador substitui o impedimento do canal irrecuperável (branch `implement/v2-lambda-fix-autonomy`).**
Esgotado o limite de reconexão com o ambiente vivo, não há mais impedimento que só sai com `factory cancel`.
`SANDBOX_CHANNEL_UNRECOVERABLE` entrou em `transient` (`src/control/rules/recovery.ts`): a Execução termina como falha com esse código,
o boot é encerrado pelo Parar de sempre e o Trabalho volta pela fila num boot novo, consumindo uma retomada operacional (o limite contra
repetição é o orçamento de retomadas). `channelUnrecoverableImpediment` foi removido e `recordChannelReport` só grava os efeitos incertos.

- **Perda registrada (como no ticket 12).** Sem disco persistente, encerrar um boot vivo e inalcançável perde o que ele tinha e não
  estava no `origin`. O despacho chama `recordLossOf` depois do Parar e antes de liberar o Slot: `work.losses[]` com o boot, o motivo
  (`channelLossReason`: código, tentativas, "Control ended the boot"), `terminatedAt: null` (não foi o serviço que encerrou), o commit
  confirmado e o marcador pelas leituras do próprio Controle, e a sessão como evidência. Por haver perda dessa Execução, a regra do 12
  (`environmentLost` em `activationPlan`) faz a próxima ativação ser de sessão substituta. Com disco persistente (Gondolin) nada é
  perdido e nenhuma perda é gravada; o Gondolin nem declara `channelRecovery`.
- **Guarda de `recordLoss` afrouxada** (`src/control/durable/loss.ts`): aceitava só boot com `environmentEnd`; agora também o boot de
  uma Execução terminada como falha (`end.outcome === 'failure'` e `dispatch.boot` igual). Os tickets 13 (três recusas do gate → perda)
  e 09 mexem perto: manter as duas condições ao integrar.
- **Marcador:** o hook de término roda no Parar, mas o holder é desarmado antes de todo Parar, e aqui o canal para desarmar está caído;
  se sobra marcador ou não é o que a leitura do Controle disser (`present`/`absent`/`unknown`). Não provado em guest real.
- **Só no caminho vivo do despacho**, como a perda do 12: a reconciliação depois de queda do controlador não grava `work.losses`.
- Critério "vira impedimento visível, sem laço" deste ticket passa a ser: sem impedimento, limitado pelo orçamento de retomadas
  (nota na V2-21 da spec). `docs/lambda-installation.md` §10 atualizado.
- Testes: `test/control/loss-flow.test.ts` (caso novo, sem disco), `test/control/channel-report-flow.test.ts` (reescrito, com disco),
  `test/control/channel-report-rules.test.ts`.

`npm run test:ci` (2026-11-21, branch `implement/v2-lambda-fix-autonomy`): 2089 testes, 2067 passam, 17 pulados, 5 falham, resultado FAIL. As 5
falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e `test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

**2026-11-21 — Passe de correções da revisão final (branch `implement/v2-lambda-review-fixes`).**
- **Filtro de segredos (item 3 da revisão, MVP §12.2):** o texto do efeito incerto (comando Bash, caminho de escrita) passa pelo filtro
  do Records do binding (`records.filterText`, o mesmo matcher das capturas) ANTES de ir para o arquivo do boot no host; dali vai
  filtrado para o documento do Trabalho e para o prompt da substituta. Filtro que falha não libera o texto: a descrição vira
  "(text withheld: the secret filter could not be applied)". Teste: `test/sandbox/lambda-tools.test.ts`.
- **Relato de canal ilegível nunca vira "nenhum efeito incerto"** (standards 4): leitura ou gravação que falha fica no histórico
  (`channel-report-unread`) e o pacote da substituta diz que o registro não pôde ser lido e que efeitos anteriores devem ser tratados
  como incertos. Os dois `.catch` silenciosos saíram (`readChannelReport` em `dispatch.ts`).
- **Should-fix 7:** o boot de canal irrecuperável agora é parado com o motivo `loss` (antes `builder execution ended`), então o registro
  do adapter (`end.reason: loss`) concorda com o do Controle. O holder do marcador segue a credencial, não o worker: fica armado até
  a retirada da credencial ou até uma parada que não seja perda (antes era encerrado quando o canal do worker fechava). Corrige a
  nota "o holder é desarmado antes de todo Parar" acima.
- A nota "só no caminho vivo do despacho" acima deixou de valer: a reconciliação depois de queda do controlador grava a perda (ticket 12).
