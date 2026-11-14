# 10 — Perguntar ao operador, cessar e retomar pela fila: incremento local

Autoridade: [ticket 10](../../.scratch/software-factory-mvp/issues/10-durable-questions-and-queued-resumption.md),
[spec §§3.4/5.5/11.3](../../.scratch/software-factory/spec.md), [interfaces Q3/Q4A/Q6/Q11](../../.scratch/software-factory/module-public-interfaces.md),
cenários V-11/V-12 da [matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).

**Estado: implementação e suíte local verdes (níveis R/S/I-local); ensaio real NÃO executado por este agente** (sem VM/modelo/GitHub/credenciais).
A receita fixa de execução real está em [§ Ensaio real](#ensaio-real-receita-one-shot). Nenhum checkbox marcado; ticket não resolvido.
Dublê não comprova fronteira substituída.

## Composição implementada

- **Builder `ask_user`** (`src/workers/ask-user.ts`, `worker-session.ts`, `worker-process.ts`). Só o Builder recebe a ferramenta. O worker
  atribui `questionId` (UUID), valida o texto (pergunta ≤ 2000, contexto ≤ 4000 caracteres, sem controle, sem segredo conhecido), calcula
  `sha256(JSON{question,context})` e **preserva a solicitação completa** como evidência protegida Records (`kind: ask-user`, fora do workspace
  do guest) **antes** de notificar. Falha de preservação interrompe a ativação sem notificar. Depois do ACK (`recorded`) ou da ausência dele
  (`unacknowledged`, 30 s ou canal perdido) a ativação **termina**: resultado com `terminate: true`, toda outra ferramenta do mesmo lote é
  recusada antes de efeito e nenhuma nova requisição ao modelo é feita (wrapper externo de `streamSimple`); nenhuma Promise espera humano.
  O resultado do worker é `status: question` com a mesma identidade/conteúdo e `acknowledged`. `refused` (inválida/obsoleta) é erro para o
  modelo e nada fica pendente.
- **Canal host** (`src/platform/host/worker-question-ipc.ts`; `worker-launch.ts`; `src/sandbox/owner-registration.ts`; `src/workers/index.ts`).
  Pelo canal IPC já herdado: `worker-question` → owner (só após o início durável, do contexto vinculado, uma por invocação) → frame
  `worker-question` no **mesmo** canal host-boot que lançou o worker → `Workers.activate` entrega a `events.question` do Controle e só envia
  `question-ack` com o resultado do commit; falha do handler = **sem ACK**. As demais demultiplexações do canal (segredos/abort) ignoram essas
  mensagens em vez de revogar a invocação.
- **Controle** (`src/control/durable/questions.ts`, `question-desk.ts`, `dispatch.ts`, `execution.ts`; regras puras `src/control/rules/questions.ts`).
  - *Registrar pergunta* (um commit): Pergunta (conteúdo, hash, referência Records, destino = issue do Ticket), impedimento `QUESTION_PENDING`
    com o `questionId` e intenção de publicação (`effectId`, estado `intended`), só para a Execução vigente `started` de Trabalho aberto/vigente.
    O registro aguarda o commit "Confirmar início" do próprio processo (ordem de mensagens ≠ ordem de commits). Mesma identidade + mesmo
    conteúdo → `known`; conteúdo diferente → `QUESTION_ID_CONFLICT` (nunca substitui).
  - Fim: `end.outcome: question` + `questionId`; ACK/notificação perdidos → a conclusão repete a solicitação e o registro ausente é feito uma
    vez (`recordedFrom: worker-completion`); conteúdo não íntegro e sem registro → impedimento `QUESTION_CONTENT_LOST`, nada publicado ou inventado.
    `stop` do boot próprio; **Slot só após cessação confirmada**; então o Trabalho volta à fila (`pending: true`) na **mesma categoria/sequência**,
    bloqueado pelo impedimento. Cessação não confirmada mantém Slot e fora da fila.
  - Publicação (no laço do proprietário, depois de cada polling, e logo após o commit — independente da cessação): intenção → commit
    `attempting` → `IssueTracker.postComment` → `published`/`failed`/`ambiguous`. Após incerteza (ou `attempting` deixado por crash) **descobre o
    marcador** antes de republicar: busca incompleta não conclui; exatamente um candidato → publicado; nenhum (busca completa) → republica;
    vários → `conflict`, nunca escolhe. Falhas conhecidas: até 5 tentativas (uma por polling).
  - Respostas: listagem **completa** dos comentários da issue dos Trabalhos com Pergunta aberta; prefixo estrito `/factory answer <id> <texto>`
    no início do corpo; autor humano (`type: User`, não `[bot]`) cujo login está em `operators`; a Pergunta tem de ser do Trabalho cuja issue
    hospeda o comentário. CLI local (`factory answer`) sob a confiança da conta administradora. *Aceitar resposta* (um commit): deduplicação pela
    identidade do ingresso (`github-comment-<id>` ou `request_id`), decisão pura, resposta única com autor/origem, remoção **só** do impedimento
    daquela Pergunta, histórico; recusas ficam em `question.ignored` (limitado). Nada é lançado pelo ACK.
  - Retomada: o despacho normal (FIFO, revalidação de autorização e dependências da própria tentativa, capacidade) vê o Trabalho elegível; o
    commit *Admitir Execução* confere a base de recuperação (Execução anterior e hash da resposta aceita) e cria Execução `mode: recovery` com
    `request.resume {previousExecutionId, questionId, answerSha256, reason: NEW_BOOT_REPLACEMENT_SESSION}`, preservando a anterior em
    `previousExecutions`. Mesmo branch/ambiente (`prepare` reutiliza), boot novo e **instrução explícita de recuperação** (Trabalho, artefatos,
    pergunta e resposta; nunca `continue` vazio). Resposta insuficiente → o Builder pergunta de novo (nova identidade).
- **IssueTracker GitHub** (`src/issue-tracker/index.ts`, `src/platform/github/index.ts`): `readInputs` (comentários após o cursor, com autor
  id/login/tipo e App autora), `findQuestion` (só comentários feitos pela App configurada com a linha de marcador exata
  `<!-- software-factory:question:<id> -->`), `postComment` (marcador + corpo). Única escrita do controlador: um `POST …/issues/<n>/comments`
  sob concessão nova `question-publish {metadata: read, issues: write}` do repositório; 4xx = falha conhecida; transporte/5xx/sucesso não
  verificável = **desconhecido**. Nenhuma label/assignee/estado é alterado; listagem parcial = indisponível.
- **CLI**: `factory answer <pergunta> <texto> [--request-id]` (identidade apresentada antes do envio; mesma identidade/conteúdo → mesmo recibo;
  conteúdo diferente → `REQUEST_ID_CONFLICT`; controlador indisponível → `REQUEST_INDETERMINATE`, código 4) e `factory question <id>`;
  `show` inclui as Perguntas; `status` conta abertas/respondidas/não publicadas. O proprietário passa `operators` da configuração.
- **Pacote** `factory-skills-v1` 1.1.0: `implement` passo 1.6 usa `ask_user` (em vez de `BLOCKED:`) e a nova seção 4 orienta a sessão de
  recuperação (inspecionar artefatos/commits antes, não repetir ferramenta às cegas, registrar a resposta como fonte de nova versão, perguntar
  de novo se insuficiente).

## Mapa AC → evidência

Níveis: **R** regras; **S** Control real + Pi Durable/SQLite temporário + dublês (GitHub, relógio, Sandbox/Workers/credenciais);
**I-local** componentes reais com a fronteira externa substituída (SDK Pi real + provider offline; worker Node24 real; owner + Protocol +
Records reais com VM/spawn dublês; adapter/issuer/gh reais com `github-world-fixture`; CLI + owner sob flock + SQLite reais).

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Identidade estável e pedido completo preservado antes do envio; Pergunta+impedimento+intenção no mesmo commit antes do ACK | `worker-question-process` (UUID do worker; evidência `ask-user` já completa quando a notificação chega; conteúdo/hash iguais na evidência), `question-ipc`, `owner-question` (mesmo canal host-boot; ACK só do Controle), `activate-question` (ACK = resultado do handler), `question-flow` 1 (no instante do ACK o storage já tem Pergunta `intended`, impedimento e Slot ainda retido) | I-local + S | Modelo real chamando a ferramenta (ensaio) |
| 2 Issue ou PR próprio conforme contexto; marcador e instrução explícita; busca antes de republicar; consulta parcial ≠ ausência | `github-question-comments` (um POST com marcador sob `issues:write` do repo; humano citando marcador e outra App não são candidatos; 502 após criar = `unknown` e descoberta o encontra; 422 = `failed`; página 2 falha → indisponível), `question-flow` 6/7 (ambíguo → 2 buscas incompletas sem repost → descoberto sem repost; vazio completo → 1 repost), `question-rules` (corpo cercado, instrução `/factory answer <id> <resposta>`, regra de destino) | I-local + S + R | PR próprio inexistente antes do ticket 14 (decisão 2); GitHub real (ensaio) |
| 3 Ativação termina sem Promise; parada/cessação antes do Slot; disco/workspace/sessão/pedido preservados | `worker-question-process` (1 requisição ao modelo; `write` no mesmo lote recusada sem efeito guest; sessão preservada com o ACK), `question-flow` 1 (`stop` antes da 2ª ativação; 2º Trabalho recebe o Slot), 11 (cessação não confirmada mantém Slot e fora da fila, publicação segue), `question-flow` 1 (retomada no mesmo branch/ambiente) | I-local + S | Disco/workspace/VM reais e reutilização do ambiente (ensaio `resume`) |
| 4 Prefixo estrito, operador autorizado, contexto e correlação; CLI confia na conta; bot/terceiro/prosa/outro Trabalho não concedem | `question-rules` (prefixo, autor), `question-flow` 2 (bot, terceiro, prosa, espaço inicial, comando não suportado e resposta em issue de OUTRO Trabalho ignorados; CLI aceita), `github-question-comments` 4 (autor/tipo/App), `answer-cli` (CLI real + owner + SQLite) | R + S + I-local | Comentário de operador real (ensaio) |
| 5 Só a primeira resposta válida duravelmente; duplicata não substitui; insuficiente → outra Pergunta; ACK perdido recupera mesma identidade/conteúdo | `question-flow` 3 (primeira vence; posterior `not-applied`; mesmo `request_id` → mesmo recibo; conteúdo diferente → conflito; polling repetido não reaplica), 4 (ACK perdido → completion deduplicada; notificação perdida → registrada da completion), 5 (mesma identidade, outro conteúdo → conflito), 9 (resposta insuficiente → nova Pergunta), `question-ipc` (silêncio/perda = `unacknowledged`), `activate-question` 2, `answer-cli` | S + I-local | Recuperação via Records após crash do controlador (decisão 5) |
| 6 Remove só seu impedimento; preserva fila/categoria/posição, limites e suspensão; não reativa entregue/cancelado nem spawn por ACK | `question-flow` 10 (impedimento de dependência intacto no commit da resposta e bloqueando), 8 (label retirada: resposta aceita, sem retomada; sequência 1 preservada), 2 (sem ativação no retorno do `accept`), `question-rules` (`WORK_NOT_OPEN` para cancelado/entregue/fechado) | S + R | Cancelamento/entrega/suspensão duráveis ainda não existem (tickets 25+): só regra |
| 7 Persistência + integrações agente/GitHub/CLI; resposta durante indisponibilidade/reinício; conteúdo perdido sem invenção | `question-flow` 8 (resposta postada com o proprietário parado, aceita no reinício com despacho fechado `RECONCILIATION_REQUIRED`, sem spawn), 5 (conteúdo perdido → `QUESTION_CONTENT_LOST`, nada publicado), demais acima | S + I-local | **Ensaio real a executar pelo supervisor** |

Mutações (JS compilado, restauradas; cada uma derruba ao menos um teste): resposta limpando todos os impedimentos (`question-flow` 10);
resposta posterior substituindo (`question-flow` 3); sem descoberta antes de republicar (`question-flow` 6/7); sem volta à fila após cessação
(`question-flow` 1+); Slot liberado sem cessação (`question-flow` 11); bot autorizado (`question-flow` 2); sem guarda de requisição ao modelo,
sem guarda de ferramenta, sem `terminate`/abort (`worker-question-process`); App não conferida em `findQuestion` e 5xx tratado como conhecido
(`github-question-comments`).

## TDD observado (honesto)

Vermelho primeiro: `question-rules` (módulo inexistente), `question-flow` (falhas reais: Pergunta antes do commit de início →
`STALE_EXECUTION`, corrigido aguardando "Confirmar início"; Trabalho em espera exibido como `executing`; clone de proxy Pi Durable),
`activate-question` (deadlock do owner roteirizado), `skill-pack` (texto/versão novos). Implementação antes do teste, verificada por mutação:
`github-question-comments`, `worker-question-process`, `question-ipc`, `owner-question`, `answer-cli`.

## Decisões de interpretação e questões abertas (operador)

1. **Sessão substituta, não continuação.** Cada boot cria um diretório de runtime/perfil próprio; a retomada usa a alternativa aprovada da spec
   §5.5 ("substituta: instrução explícita de recuperação com Trabalho e artefatos; registrar motivo") com `reason: NEW_BOOT_REPLACEMENT_SESSION`.
   A sessão anterior fica preservada no disco do host, mas não é reaberta. Continuação nativa da mesma sessão exigiria reabrir o arquivo de
   sessão de outro boot (decisão a confirmar).
2. **PR como destino.** A regra de destino existe, mas antes do ticket 14 nenhum Trabalho tem PR próprio; `CodeRepository.findQuestion/postComment`
   não foram implementados e um destino PR é recusado (`QUESTION_DESTINATION_NOT_ENABLED`, inalcançável hoje).
3. **Operador por login.** A configuração só tem logins (`operators`); autorização = login configurado (sem distinção de caixa) + `type: User`
   e sem sufixo `[bot]`; o id do autor é registrado na resposta. Renomeação/reuso de login fica como risco; ids na configuração resolveriam.
4. **Custo da ingestão.** Cada rodada lê a listagem completa da issue de cada Trabalho com Pergunta aberta; o cursor (maior id lido) só avança
   após listagem completa; edições posteriores de um comentário já lido não são vistas.
5. **Crash do controlador entre commit e ACK.** A perda do canal host-boot revoga o worker (semântica existente): a Pergunta existe e é
   publicada, mas a Execução fica `held` com Slot até a reconciliação (ticket 26). Se notificação E conclusão se perdem, a solicitação fica só
   na evidência Records do worker; não há leitura automática dela (`Workers.observe` não implementado).
6. **Publicação sob pausa/barreira.** Publicação e ingestão rodam mesmo com despacho fechado ou pausa global: não lançam nada (pausa = novos
   disparos). Confirmar.
7. **Limites de texto.** 2000/4000/2000 caracteres para caber no orçamento de prompt do Builder (16 KiB); o contexto é omitido da instrução
   de recuperação se não couber (a resposta nunca).
8. **Suficiência.** O Controle não julga a resposta; o pacote instrui perguntar de novo. Retirada de autorização durante a espera é observada
   na revalidação em memória (suspensão durável é o ticket 25).
9. **Pacote alterado dentro de `factory-skills-v1`** (1.0.0 → 1.1.0, só `implement`): um ambiente já semeado com 1.0.0 recusa reutilização
   (nunca sobrescreve); o ensaio usa armazenamento/Trabalho/ambiente novos.

## Ensaio real (receita one-shot)

Receita: `dist/test/entrypoints/question10-qualification.js` (fonte `test/entrypoints/question10-qualification.ts`). `--plan` é inerte
(teste `question10-qualification`). Fases one-shot com tombstone `*-intent.json` exclusivo em `$HOME/software-factory-test/y5/q10-question-v1/`
(criado na `preflight`; existir = consumido). Sem retry; falha grava `*-held.json`.

Pré-requisitos (operador/supervisor): os mesmos do ticket 09 (raiz `y5` 0700 com store OAuth da Factory e `run/`; cópia exclusiva 0600 da
chave da App em `y5/credentials/app.pem`, removida ao fim; `gh`, `git`, `flock`, `qemu-img`, `systemd --user`, KVM; assets `assets34`; SDKs de
desenvolvimento preparados). A App precisa de `issues: write` na instalação (já é o teto do tracker). A issue **#3** de
`Sanmoo/java-springboot-event-sourcing` deve ser a **única** aberta com `ready-for-agent` e seu pedido deve **exigir uma pergunta** ao operador
antes de alterar arquivos (por exemplo: "antes de escrever, pergunte ao operador pela ferramenta da Factory qual nome de arquivo usar");
sem isso o Builder pode concluir sem perguntar e os ACs reais não são demonstrados (resultado registrado, sem nova tentativa).

```sh
NODE="env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node"
$NODE dist/test/entrypoints/question10-qualification.js --plan
$NODE dist/test/entrypoints/question10-qualification.js preflight   # GitHub somente leitura
$NODE dist/test/entrypoints/question10-qualification.js ask         # 1 VM, 1 Builder, modelo real; 1 comentário em #3 (até ~45 min)
# Com o controlador PARADO (ask terminou): na issue #3, pela conta Sanmoo, UM comentário começando exatamente com
#   /factory answer <questionId de ask-result.json> <resposta>
$NODE dist/test/entrypoints/question10-qualification.js resume      # mesmo storage; resposta aceita; 1 boot novo, 1 Builder de recuperação
$NODE dist/test/entrypoints/question10-qualification.js inspect     # somente leitura
# se uma fase terminar com o boot próprio possivelmente ativo:
$NODE dist/test/entrypoints/question10-qualification.js stop-environment
```

Efeitos e limites:

- **GitHub**: só a App da Factory. Leituras por finalidade como no 09 (`tracker-read` agora também lê comentários de #3); escrita: **no máximo
  um** `POST /repos/Sanmoo/java-springboot-event-sourcing/issues/3/comments` por fase (`ask`, `resume`), sob `question-publish {metadata: read,
  issues: write}`, guardado pela receita (outro Ticket ou segundo comentário → recusado). Builder: `builder-start` somente leitura (push/PR
  impossíveis). Nenhuma label/assignee/estado alterado. O comentário de resposta é do operador (efeito humano, fora da receita).
- **VM**: 1 ambiente novo (40 GiB qcow2 de assets34, 4096 MiB, 2 vCPU); `ask` = 1 boot; `resume` reutiliza o mesmo ambiente/branch com 1 boot
  novo; parada pública ao fim de cada Execução; sem `remove`/cleanup.
- **Modelo**: `openai/gpt-6-luna` pelo store OAuth da Factory; **no máximo 2 ativações** (uma por fase), cada uma ≤ 60 requisições,
  ≤ 120 ferramentas, prazo 30 min, retries 0; sem teto de cobrança no provedor.
- **Prazo**: 45 min por fase; `resume` desiste após ~5 min sem resposta aceita (`answer-not-observed`).

Observações esperadas (`ask-result.json`, `resume-result.json`, `inspect-result.json`):

1. `ask`: `events` com um `prepare`, um `start`, um `activate` (`/implement …/issues/3`), um `question` seguido de `question-ack
   {status: recorded}`, um `stop`, um `postComment` com resultado `published`. Em `final`, o Trabalho #3 com `execution.end.outcome: question`,
   `end.cessation: confirmed`, `slot.held: false`, `queue.pending: true`, `dispatch.reasons: [QUESTION_PENDING]`; `questions[0]` com
   `recordedFrom: worker-notification`, `publication.state: published` e URL do comentário; `open[0].answerWith` com o comando a postar.
2. `resume`: `final` com a Pergunta `answered` (`author {kind: github, login: Sanmoo, id}`, `origin.commentId`), sem `QUESTION_PENDING`;
   `previousExecutions[0]` = Execução do `ask`; `execution.mode: recovery`, `request.resume` com o hash da resposta,
   `NEW_BOOT_REPLACEMENT_SESSION`; `events` com um `prepare` (checkout `reused: true`), um `start` (boot novo), um `activate` cujo prompt começa
   com `Factory recovery instruction` e contém a resposta, `stop` e Slot liberado. Se o Builder perguntar de novo: segunda Pergunta publicada.
3. `inspect`: comentários de #3 (Pergunta da App com marcador e a resposta do operador), Perguntas, recibos das duas Execuções, artefatos
   (`spec/vN` incluindo a resposta como fonte se ela mudou o pedido), commits na branch própria (nunca publicados), `secretScan` sem `ghs_`/chave.
4. Disposição do operador: `held` (código/fase), `answer-not-observed`, Builder que não perguntou, prazo atingido.

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60`, sem npm/npx, após `rm -rf dist`:
`dependency-cruiser` sem violações (257 módulos, 1437 dependências); `eslint . --max-warnings 0` exit 0; `tsc -p tsconfig.json` exit 0;
**112 arquivos** `dist/test/**/*.test.js`, um por vez (`--experimental-test-module-mocks --test --test-concurrency=1`):
**814 pass, 0 fail, 10 skipped, 0 cancelled** (≈ 325 s). Os 10 skips são os mesmos de antes (host-dependentes); `test/sandbox/gondolin.test.ts`
continua `skip:true`. Uma correção posterior (registro recusado na conclusão → impedimento explícito `QUESTION_NOT_RECORDED`, só `dispatch.ts`/
`questions.ts`) foi recompilada e verificada com o gate estático completo e todos os arquivos `test/control/*` mais `control-public`,
`answer-cli`, `admission-cli` e `dependency-cli` (verdes).

Novos arquivos: `question-rules` (7), `question-flow` (11), `github-question-comments` (4), `worker-question-process` (4), `question-ipc` (3),
`owner-question` (1), `activate-question` (2), `answer-cli` (1), `question10-qualification` (2). Ajustados: `skill-pack` (texto 1.1.0) e as
fixtures de provider do Host público (`edit-provider-preload`, `adapter-copy-read-provider-preload`: o conjunto de ferramentas do Builder passa
a incluir `ask_user`).
