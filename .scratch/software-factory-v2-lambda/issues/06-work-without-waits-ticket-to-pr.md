# 06: Trabalho sem esperas, do Ticket ao PR, no Lambda

**What to build:** Primeira jornada integrada: com o adapter Lambda selecionado, um Trabalho que não precisa de espera externa vai do Ticket ao PR.
Builder, revisões internas, tratamento de achados e push acontecem no mesmo boot, sem checkpoint entre Builder e revisores; ao fim, Parar
e Remover.

**Decisão a tomar neste ticket.** Hoje o Controle confirma a identidade da proposta entregue, a impressão do checkout e a fonte
preservada por leituras confinadas do workspace no host. No Lambda o workspace só existe no guest, e a spec diz que nada lido do guest
decide autorização (V2-26). A spec da v2 não diz o que substitui essas leituras. Antes de implementar, propor a substituição (por
exemplo: o que pode ser ancorado no `origin`, o que vira observação não autoritativa pelo canal, o que deixa de existir quando o adapter
não declara disco persistente) e registrar a decisão do Operador no `## Answer`. Se a decisão alterar contrato da spec, parar e pedir a
decisão em vez de assumir.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-02 (Remover parcial), V2-05 (mesmo boot), V2-08, V2-26; MVP §5.6, §7.3.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 01, 05

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] A decisão sobre as leituras de host do workspace está registrada, com aprovação do Operador, antes do código que depende dela.
- [x] Com o adapter Lambda, um Trabalho sem espera externa percorre Builder, revisões de padrões e de spec no mesmo boot, tratamento de achados, publicação do PR e fim, pela composição de produção sobre o fake do serviço.
- [x] Não há workspace no host nem cache bare montado: o clone é feito no guest a partir do `origin`.
- [x] Ao fim, Parar confirma cessação antes de liberar o Slot; Remover encerra o que restar e registra, sem tocar branch nem PR.
- [x] Nenhum mecanismo de checkpoint além do Git remoto: sem S3, git bundle ou cópia do workspace no host.
- [x] O mesmo cenário continua passando com o adapter Gondolin, sem mudança de comportamento.
- [ ] Jornada em conta AWS real com um repositório real, no perfil de aceite (`us-east-1`, ARM64), com evidência registrada no `## Answer`. Exige autorização específica do Operador antes de rodar (conta, permissões, teto de consumo, prazo e cleanup), conforme `docs/agents/experiment-proofs.md`. Sem autorização, o critério fica desmarcado e declarado; nunca é dado por feito pelo fake.

## Answer

### Decisão do Operador (registrada antes do código que depende dela)

Aprovada pelo Operador em 2026-11-21, em conversa com o orquestrador (fonte: notas `05-operator-decisions.md`, com o inventário em
`03-host-workspace-reads.md`). Vale SÓ quando o adapter não declara disco persistente; o comportamento do Gondolin fica o do MVP.

**Decisão 1 (1A): identidade da revisão e onde fica o push.**

1. A identidade da proposta (H1) antes e depois de cada rodada de revisão é calculada dentro do guest por um programa FIXO, rodado pelo
   host pelo canal (o agente não escolhe o programa nem os parâmetros). É observação não autoritativa: detecta mudança durante a revisão.
   Neste perfil, a "identidade observada pelo Host" do MVP §6.4 passa a ser atestada pelo guest.
2. Depois da rodada verificada, o Builder faz o push no MESMO boot. A Execução de implementação recebe acesso de escrita limitado à branch
   do Trabalho. A Execução de publicação separada e posterior (que precisa do workspace preservado) não existe neste perfil.
3. A checagem autoritativa é a leitura do `origin` pelo próprio Controle: a ponta da branch é igual ao commit verificado antes de o PR
   ser aberto (a checagem que já existe em `rules/publication.ts`).

Rejeitado: push antes da revisão ancorado na ponta do `origin`.

**Decisão 2: as outras leituras de host.**

- **2a, impressão do checkout (H2):** "progresso" depois de um fim de orçamento = a ponta da branch do Trabalho avançou no `origin`
  (leitura do próprio Controle). Mesma medida da V2-14.
- **2b-A, fonte preservada (H3):** ler os mesmos dois arquivos (`sources.json` + arquivo referenciado: existe e está listado) pelo canal,
  antes do Parar. Mesma força de hoje. O Operador lê a V2-26 explicitamente como não cobrindo este caso.
- **2c, exportação de evidência (H4):** coletar pelo canal antes de cada Parar de boot, para os Records; o que não foi coletado antes de
  uma morte é declarado perdido (V2-34). O `preserve` do cleanup então não acha nada (`absent`).
- **2d, inspeção do checkout (H5) e observação de storage (H6):** não se aplicam neste perfil.

**Decisão 3 (3D): `/artifacts` entre boots** (implementação no ticket 08; aqui só o que ele precisa fica guardado).

- No início de cada boot o host reenvia SÓ `spec/` e `instructions/` pelo canal, do que coletou antes do Parar anterior (2c). Devolvido
  como recebido; o host não certifica conteúdo.
- Capturas de revisão de rodadas anteriores (`review/r<N>`) e cópias de saída são por boot e descartáveis. Os prompts de retomada deste
  perfil devem dizer isso em vez de "/artifacts foram preservados".
- Se o boot anterior morreu antes da coleta, o aviso do novo boot declara essas versões perdidas; a sessão substituta (ticket 13)
  preserva o pedido de novo, numerando depois da última versão registrada.
- O skill pack é material da Factory e é reenviado a cada boot de qualquer forma (não é decisão).
- Rejeitado: commitar artefatos na branch do Trabalho (MVP §7.3); `/artifacts` totalmente descartável.

**Decisão sobre quem abre o PR (Operador, 2026-11-21, transmitida pelo orquestrador durante a implementação):** instalar `gh` na imagem
do guest Lambda, para o próprio Builder abrir o PR, no mesmo boot, sob as regras de publicação do MVP. O pacote entra no molde fixo com a
versão fixada no pin da release (muda a chave das imagens: esperado); o token continua entregue como hoje (ambiente explícito pelo canal,
nunca gravado no guest); o usuário revisor não ganha nada com isso.

Escolhas do orquestrador (não são decisões do Operador): acesso ao serviço pelo CLI `aws lambda-microvms` atrás da porta `LambdaService`;
credencial do clone no guest = token reduzido entregue por comando em ambiente explícito pelo canal (V2-24), sem deploy key.

### O que foi construído

Com `sandbox.adapter: lambda`, um Trabalho sem espera externa vai do Ticket ao PR draft próprio numa única Execução e num único boot;
ao fim, Parar (cessação confirmada pelo serviço antes de liberar o Slot) e Remover. Nenhuma chamada AWS, nenhum `ssh`/`websocat`, nenhuma
MicroVM e nenhum modelo foram usados.

- **Composição de produção.** `composeProductionExecution` compõe o adapter Lambda (a recusa `SANDBOX_ADAPTER_UNAVAILABLE` e o check
  `sandbox-adapter` do Validar saíram). O perfil não chega ao Controle: `ports.configuration` é `null` e a composição entrega o perfil ao
  Sandbox em `prepare`/`start`. `ProductionInput.lambda` injeta o que fica ABAIXO do adapter (conta, transporte, relógios, lançamento do
  processo worker); a produção não passa nada.
- **Ramificação por capacidade no Controle** (`src/control/durable/dispatch.ts`, `const diskless = ports.sandbox.capabilities?.persistentDisk === false`;
  ausência de declaração = MVP). Nunca pelo nome do adapter (a regra ESLint de `src/control/**` continua valendo).
  - *Preparar sem checkout de host* só é aceito sem disco persistente (com disco, continua `PREPARE_CHECKOUT_MISSING`). O Controle lê o
    `origin` ele mesmo (`readOrigin`: `findPublication` com a branch do Trabalho e a base) e nomeia o commit do clone ao Iniciar
    (`start({ checkout: { repository, installationId, commit, branch } })`): a ponta da branch do Trabalho quando ela existe, senão a ponta
    da base. `origin` ilegível não inicia nada: a reserva é liberada sem consumo e o Trabalho volta à fila (`ORIGIN_*`).
    `request.baseCommit` é a base do primeiro início do Trabalho (base das revisões); `execution.origin = { atStart, startCommit }`.
  - *Progresso por `origin` (2a):* sem disco, `observeCheckout` não é chamado; depois de um fim de orçamento com cessação confirmada o
    Controle lê o `origin` de novo e `originProgress` (regra pura em `rules/budget-continuation.ts`) decide continuação x retomada.
  - *Publicação no mesmo boot (1A):* a admissão marca `request.publishInBoot` e o grant da Execução passa a ser `builder-publish`
    (`purposeOf`). Depois do Builder de implementação concluir e de `recordVerification`, ANTES do fim da Execução: `evaluateLivePublication`
    (base viva, `publishableContent(..., { live: true })`), descoberta com a leitura do `origin` pelo Controle (`discover`, extraída de
    `reconcileOne`; `recordDiscovery({ live: true })` não enfileira nada), e uma **segunda ativação do Builder na mesma Execução e no mesmo
    boot**: invocação própria (`execution.inBootPublication`), sessão publish-only (sem edit, sem handoff), `pushPolicy` com o único push
    com lease que o Controle derivou, prompt de publicação do MVP (`gh pr create --draft`). A tentativa é gravada antes do lançamento
    (`beginLivePublication`). O vínculo do PR continua sendo a descoberta DEPOIS da cessação, que só aceita o PR draft próprio exatamente
    no commit verificado. O Builder de implementação continua sem política de push: o Host do Builder recusa todo push dele.
  - Descoberta inconclusiva dentro do boot (leitura incompleta ou retida) vira bloqueio explícito
    (`VERIFIED_COMMIT_NOT_PUBLISHED_BEFORE_STOP` + `PUBLICATION_BLOCKED`), nunca uma publicação enfileirada que não acharia o commit.
- **Adapter Lambda** (`src/sandbox/lambda/`):
  - `artifacts.ts`: os programas fixos pelo canal. Identidade da proposta (1A), fonte preservada (2b-A), coleta de `/artifacts` (2c) e
    envio do skill pack. `createSandbox().observeProposal` / `verifyPreservedSource` usam o canal do boot corrente quando o ambiente é
    Lambda; `observeCheckout` responde `CHECKOUT_NOT_ON_HOST`; `exportEvidence` responde `absent`.
  - `boot.ts`: o Iniciar envia o skill pack (resultado `seeds`); o Parar coleta `review/`, `spec/` e `instructions/` para os Records do
    Trabalho (`<raiz>/<trabalho>/evidence/<id>/files/`) antes do `TerminateMicrovm` e grava a referência em `boot.json` (`artifacts`:
    `preserved` | `absent` | `lost`). Boot que morre sem coleta fica `lost`.
  - `owner.ts`: o dono do boot no processo do controlador. `serveLambdaOwner` serve o mesmo endpoint e protocolo do dono Gondolin
    (`serveBootOwner`, extraído de `serveOwnerRegistration`), vincula ferramentas por invocação com `serveLambdaTools` e lança workers
    como filhos do processo (`launchWorker` com `HostedWorkerBoot`, sem unidade systemd). Com `createSandbox({ lambdaBootOwner: true })` (o que a composição de produção passa) o `start`
    sobe o dono e o `stop` o fecha antes de parar; sem a opção o boot inicia sem dono, como nos tickets 04 e 05. `workerOwnerEndpoint` é a descoberta do endpoint (`createWorkers({ ownerEndpoint })`).
    `removeLambdaEnvironment`: Remover encerra boots ainda vivos (confirmado pelo serviço), apaga os diretórios de runtime do host e grava
    `removal.json`; não toca branch nem PR; disco, workspace e artifacts saem `absent`.
  - Credencial do clone: sem credencial dada, `start` emite o token reduzido de fetch do host (Contents:read), entrega como ambiente do
    `git` do clone e tenta revogar em seguida.
  - `guest-image.ts`: `github-cli` no molde fixo (decisão do Operador). O revisor não ganha nada: não tem Bash nem credencial.

Arquivos de teste: `test/entrypoints/lambda-journey-composed.test.ts` (jornada pela composição de produção), `test/control/inboot-publication-flow.test.ts`
(Controle real com sandbox sem disco e com disco: o mesmo cenário mantém o fluxo do MVP), `test/sandbox/lambda-artifacts.test.ts` (os
programas fixos rodados com o `python3` local), casos em `publication-rules`, `continuation48-rules`, `lambda-guest-image`,
`lambda-validate`, `adapter-selection`, `configuration`, `release-composition`; `test/entrypoints/journey-composed.test.ts` (Gondolin) passa
sem alteração.

### O que a jornada composta substitui

A conta AWS (`lambda-service-fake.ts`), o guest (`lambda-guest-fake.ts`) e o PROCESSO worker (SDK do agente + modelo), roteirizado pelo
`lambdaWorkerLauncher`: ele usa o endpoint do dono, o endpoint de ferramentas vinculado e as notificações que um worker real usa, mas a
captura do handoff é um comando do roteiro, e a política de push do Host do Builder (que vive no processo worker) não é exercitada ali. O
Remover é exercitado chamando a porta de cleanup da composição depois da publicação, não pela mesa de entrega depois de um merge.

### Formas não provadas (nenhuma rodou num guest real)

- **Versão do `github-cli`** (`2.83.0-r0`): NÃO observada em prova. Precisa ser conferida no índice `community` do Alpine `v3.23` antes do
  primeiro build real; pin errado falha o build com a causa visível.
- **Programas de `artifacts.ts`:** `python3 -I -S -c <programa>` com todos os argumentos entre aspas simples; testados com o `python3`
  3.14 local, o guest fixa 3.12. A identidade no guest não é byte a byte a do host (mesmos fatos, outra serialização); só é comparada
  consigo mesma. A coleta junta o stdout inteiro em memória, em base64, com teto de 64 MiB e 8192 arquivos (acima disso falha e a
  evidência é declarada perdida); o MVP exportava até 1 GiB.
- **Dono do boot no processo do controlador:** `launchWorker` com `HostedWorkerBoot` (sem checagem de unidade/cgroup) nunca lançou o
  executável worker real; se o controlador morre, os workers perdem o IPC.
- **Token de escrita durante a implementação:** o GitHub não limita um token a uma branch. O limite é a política de push do Host do
  Builder mais a verificação do Controle depois da tentativa (refs inesperados, head diferente do verificado), como no MVP.
- **`gh` com o token do canal:** o Bash do Lambda exporta `GH_TOKEN` (ticket 05); `gh pr create` com ele nunca rodou num guest.

### Limites e pendências

- **Jornada em conta AWS real: não executada, sem autorização do Operador.** O critério fica desmarcado; nada acima foi observado numa conta.
- A decisão 1A.3 diz "antes de o PR ser aberto". Como no MVP, push e `gh pr create` acontecem na mesma ativação do Builder e a checagem do
  Controle (ponta = commit verificado) roda na descoberta depois da cessação, antes de o PR ser VINCULADO e aceito; um PR em outro head é
  bloqueado, nunca adotado. Separar em push, checagem e ativação só de PR é possível com a recuperação `create-pull-request-only` que já existe.
- A ativação de publicação no boot não aceita `ask_user` (não há handler): uma pergunta ali encerra a ativação e a descoberta decide.
- Retomadas neste perfil ainda bloqueiam com `RECOVERY_CONTEXT_INSUFFICIENT` (`recoveryContext` exige ambiente reutilizado): é o ticket 08.
  Isso inclui a Execução de publicação que as regras do MVP ainda enfileiram depois de uma tentativa (recuperação só de PR, atualização).
- `doctor` continua sem conferir `ssh`/`websocat` no host. `owner.ts` do controlador ainda exige os guest assets da release e roda o
  inventário de runtime do Gondolin numa instalação Lambda (ticket 15).
- Não foi red-green estrito: os programas do guest, o dono do boot e os ramos do Controle foram escritos antes dos testes que os cobrem.
  Vermelhos reais que os testes pegaram: `findPublication` recusa `issueNumbers` vazio (só a jornada composta mostrou) e o cenário de
  `origin` ilegível.

`npm run test:ci` (2026-11-21, depois do merge da ponta de `integration/software-factory-v2-lambda` com o ticket 11): 1987 testes, 1965
passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e
`test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

### O que os tickets seguintes precisam saber

- **07 (gate de preservação):** o grant já é de escrita (`publishInBoot`); falta a política de push de WIP no Host do Builder (hoje todo
  push fora da ativação de publicação é recusado) e atribuir os heads confirmados pelo gate (`knownRemote`), senão viram divergência. O
  ponto de inserção é o mesmo da publicação no boot: depois de `handle.completed`, antes de `recordEnd`. O molde de "várias ativações do
  Builder numa Execução" é `publishInBoot` em `execute` (invocação própria, `lifecycle.attach`, `settleLivePublication`).
- **08 (retomada):** `readOrigin` e `execution.origin.startCommit` já dão a ponta da branch no início; trocar `recoveryContext` pela
  continuidade por `origin` quando `diskless`. O que reenviar (3D) está em `boot.json.artifacts.reference` do último boot com `preserved`
  (`sandbox.boots({ environment })`), em `<raiz>/<trabalho>/evidence/<id>/files/{spec,instructions}`; `seedProgram`/`uploadLambdaSeeds`
  são o molde do envio. Os prompts que afirmam preservação continuam os do MVP.
- **10/12 (cessação e perda):** Parar e liberação do Slot são os do MVP (`stopOwnBoot` → `releaseAfterCessation`); o dono do boot é
  fechado dentro de `createSandbox().stop`. Perda antes da coleta já fica `artifacts: lost` no registro do boot. Remover é
  `removeLambdaEnvironment` (falta o ref marcador).
- **14 (consumo e quota):** códigos de recusa do Iniciar chegam como `START_<código>`; nada foi classificado como capacidade.
- **15 (inventário):** `removal.json` e os registros de boot ficam; `image.json` não é apagado pelo Remover.
- **11:** nada de `lambda/tools.ts` nem do contrato de resultado de ferramenta foi alterado aqui.
