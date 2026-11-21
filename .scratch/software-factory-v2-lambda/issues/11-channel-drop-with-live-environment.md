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
- [x] Reconexão que falha repetidamente com ambiente ativo tem limite e vira impedimento visível, sem laço.

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
