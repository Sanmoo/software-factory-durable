# 07: Gate de preservação e encerramento nas esperas

**What to build:** Quando o adapter não declara disco persistente, toda devolução de controle com espera externa (Pergunta ao humano, espera de CI,
prontidão) é precedida pelo gate de preservação, imposto pelo Controle e não confiado ao prompt. Aceito o gate, a MicroVM é encerrada
(não suspensa) e a cessação confirmada precede a liberação do Slot. O comportamento do Gondolin fica como no MVP.

Este ticket cobre o gate antes das esperas; a troca planejada e a sessão substituta reutilizam o mesmo gate nos tickets 09 e 13.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-05, V2-06, V2-07, V2-08, V2-09.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 06

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] O gate verifica no guest: workspace limpo, incluindo untracked não ignorados; ausência de stash; `HEAD` igual à ponta da branch do Trabalho consultada no `origin` por `ls-remote`, sem confiar na ref de acompanhamento local.
- [x] Workspace sujo, untracked, stash, commit sem push, remoto indisponível e remoto não confirmado são recusados, cada um com motivo próprio (os seis casos de G1 como testes de regra).
- [x] A recusa volta ao Builder com o motivo, para correção, na mesma devolução; o Builder pode publicar WIP mesmo antes de existir PR.
- [x] Três recusas seguidas na mesma devolução encerram o boot como perda, com o diagnóstico da última, e a sessão substituta retoma pela fila consumindo uma retomada operacional. (Decisão do Operador em 2026-11-21, V2-07 emendado; antes: "geram Bloqueio com o diagnóstico da última". Implementado no ticket 13.)
- [x] O texto entregue ao Builder diz que o procedimento não autoriza versionar segredos ou dados impróprios: sem publicação segura, ele reporta o impedimento em vez de forçar o commit.
- [x] Depois do gate aceito em Pergunta, espera de CI e prontidão, a MicroVM é encerrada e a cessação confirmada pelo serviço precede a liberação do Slot.
- [x] O commit confirmado pelo gate fica registrado no Trabalho para a retomada.
- [x] Com adapter que declara disco persistente, nenhum gate é exigido e o fluxo do MVP não muda.

## Answer

### O que foi construído

Num sandbox que não declara disco persistente, o Controle impõe o gate de preservação antes de toda devolução de controle em que o boot vai
acabar para uma espera externa: fim `question` (Pergunta) e fim `completed` (seguem as esperas no GitHub: CI e prontidão). Só o gate aceito
deixa a Execução terminar; depois vêm o Parar (cessação confirmada pelo serviço) e a liberação do Slot, na ordem do MVP. Com disco
persistente nada é perguntado e o fluxo do MVP é o mesmo. Nenhuma chamada AWS, MicroVM, `ssh`/`websocat` ou modelo foram usados.

- **Observação no guest** (`src/sandbox/lambda/preservation.ts`): um programa FIXO rodado pelo host pelo canal (`preservation-gate`):
  `git status --porcelain --untracked-files=all` (modificados e untracked não ignorados contados à parte), `git stash list`, `HEAD` e
  `git ls-remote` da branch do Trabalho na URL que o HOST nomeia (não no `origin` gravável do guest, nunca a ref de acompanhamento). A
  credencial do `ls-remote` é o token reduzido de fetch do host (Contents:read), só em ambiente explícito, revogado em seguida.
  Contrato `PreservationObservation` em `src/contracts`; `createSandbox().preservationGate`; porta `ports.sandbox.preservationGate`.
- **Regra pura** (`src/control/rules/preservation.ts`): `gateDecision({ observation, origin })`. Aceita só workspace limpo, sem stash,
  `HEAD` = ponta pelo `ls-remote` do guest E = ponta lida pelo PRÓPRIO Controle no `origin`. Motivos: `WORKSPACE_MODIFIED`,
  `WORKSPACE_UNTRACKED`, `STASH_PRESENT`, `HEAD_NOT_PUBLISHED`, `REMOTE_UNAVAILABLE`, `REMOTE_UNCONFIRMED` (os seis de G1) e
  `GATE_OBSERVATION_UNAVAILABLE` (o guest não pôde ser observado). Também: `gateRefusalLimit` (3), `gateCorrectionPrompt`, `gateHold`,
  `recordPreserved`/`preservedHeads`.
- **O seam único do gate** (`src/control/durable/dispatch.ts`):
  - `checkPreservation(work, { environment, boot, branch })`: UMA checagem (observação no guest + leitura do `origin` pelo Controle, feita só
    quando o guest alega estar publicado). Não grava nada e não lança.
  - `preservationGate(occasion)` dentro de `execute`: o laço da devolução. Grava cada checagem (`recordGateCheck`), devolve a recusa ao
    Builder e repete; retorna `accepted` | `held` | `stale`. `occasion`: `question` | `ci-wait` | `planned-swap` | `substitute-end` (os dois
    últimos já existem no tipo para os tickets 09 e 13 chamarem a mesma função).
- **Recusa de volta ao Builder:** uma ativação do Builder na MESMA Execução e no MESMO boot (molde de `publishInBoot`): invocação própria
  gravada antes do lançamento, fase `builder-preservation`, ferramentas do Builder sem handoff, texto com o motivo, e política de push
  `wip` no Host do Builder (`src/workers/push-policy.ts`): o único push aceito é `git -C /workspace/checkout push <url> HEAD:refs/heads/<branch>`,
  sem force (fast-forward ou criação da branch; não reescreve nem apaga nada). Não precisa existir PR. O texto diz que o procedimento não
  autoriza versionar segredos e que, sem publicação segura, o Builder reporta o impedimento em vez de forçar o commit; o prompt de sistema
  de produção dessa sessão (`productionProfile.prompts.builderPreservation`) repete isso.
- **Três recusas seguidas** na mesma devolução: `hold` da Execução com `PRESERVATION_GATE_REFUSED`, o diagnóstico da última em `held.detail`
  e o próximo passo em `held.nextStep`. O boot NÃO é parado e o Slot fica retido (leitura de V2-07: "o ambiente continua sujeito à rotação";
  parar destruiria o que não foi publicado). As credenciais são retiradas pelo hold. São duas correções pedidas: a terceira recusa bloqueia.
- **Registro:** `execution.preservationGate = { occasion, attempts[] }` (cada checagem, com a ativação de correção e como terminou) e, no
  aceite, `work.preservation = { commit, branch, confirmedAt, executionId, boot, occasion, heads[] }` no mesmo commit durável, mais eventos
  `preservation-accepted`/`preservation-refused` no histórico. Campos opcionais, sem migração.
- **Atribuição dos heads confirmados** (pendência deixada pelo 06): `knownRemote(..., preserved)` soma `work.preservation.heads` aos heads da
  Factory, e `decideDiscovery` publica o commit verificado por cima de uma ponta WIP confirmada (lease nela) em vez de
  `REMOTE_BRANCH_UNKNOWN_CHANGE`; com PR vinculado, um head WIP confirmado conta como head anterior da Factory.
- **Credencial na Pergunta:** sem disco, o grant não é mais retirado no registro da Pergunta (`external-wait`); fica até o gate aceitar (a
  correção publica com ele) e é retirado no fim (`ended`) ou no hold. Com disco, continua `external-wait`.
- O relógio de timeout da Execução corre até o gate terminar.

Testes: `test/control/preservation-rules.test.ts` (regra: os seis casos, texto, bloqueio, atribuição), `test/sandbox/lambda-preservation.test.ts`
(o programa real com `bash` e `git` locais contra um clone temporário e um bare como `origin`: os casos de G1, inclusive ref de
acompanhamento desatualizada), `test/control/preservation-gate-flow.test.ts` (Controle real: Pergunta com recusa, correção e aceite; fim
`completed`; três recusas; remoto indisponível; sandbox com disco), `test/workers/push-policy.test.ts` (push `wip`),
`test/entrypoints/lambda-journey-composed.test.ts` (composição de produção + conta fake: gate recusa um resto untracked, correção, aceite,
MicroVM `TERMINATED`, commit confirmado no Trabalho), `test/control/inboot-publication-flow.test.ts` (gate aceito de primeira; sem gate com disco).

### Formas não provadas

- O programa `preservation-gate` não rodou num guest real (Alpine, `git` e `grep`/`awk` do BusyBox); rodou com `bash`, `git` e GNU locais.
- A ativação `builder-preservation` nunca rodou com worker/modelo reais: é uma sessão NOVA do Builder (não a continuação da sessão que
  pediu a devolução). A sessão gravada para a retomada continua a da implementação; ela não viu a correção.
- O push `wip` com o token do canal e um `git fetch` do Builder no guest (para integrar uma ponta que andou) nunca rodaram num guest.
- Critério 6: Pergunta e fim `completed` têm cenário; "prontidão" não tem devolução de controle própria no código (as esperas de CI e de
  prontidão acontecem sem boot, depois de uma Execução terminar), então é o mesmo caminho do fim `completed`. As Execuções de reparo que
  antecedem a prontidão são retomadas e, neste perfil, ainda bloqueiam até o ticket 08. O cenário de Pergunta está no nível de fluxo (dublê
  do sandbox); só o fim `completed` passa pela composição de produção com o serviço fake.
- Não foi red-green estrito: regra, programa e ramo do Controle foram escritos junto com os testes de cada fatia; o vermelho real que os
  testes pegaram foi o registro durável (`attempts` mutado fora do documento não era gravado).

### Limites e o que os tickets seguintes precisam saber

- **08 (retomada):** o commit de partida da retomada é `work.preservation.commit` (com `branch`, `boot`, `occasion`); `execution.origin.startCommit`
  continua sendo o que o boot clonou. A ponta do `origin` deve ser esse commit ou descender dele; senão, divergência. Uma Execução em hold por
  `PRESERVATION_GATE_REFUSED` não tem `work.preservation` novo: vale o anterior, se houver.
- **09 (troca planejada) e 13 (substituta):** chamar `preservationGate('planned-swap' | 'substitute-end')` dentro de `execute` (precisa de
  `environment`, `boot` e `lifecycle` vivos); para uma checagem sem o laço, `checkPreservation`. O gate usa `wait(...)`, então o timeout da
  Execução o interrompe. Se a correção falhar ao lançar (`not-started`), a recusa conta e o laço segue.
- **10/12 (perda):** uma Execução em hold pelo gate fica com boot vivo e Slot retido até a rotação, o reinício do controlador (a reconciliação
  para o sobrevivente e classifica `PRESERVATION_GATE_REFUSED` como bloqueante) ou a decisão do operador. O que não estava no `origin` se perde.
- Um commit humano que o Builder integrou e que virou a ponta confirmada entra em `heads` como da Factory. As pontas de terceiros já
  observadas pelas descobertas continuam exigidas pela checagem de preservação do MVP.
- Depois de uma publicação verificada, uma correção que cria commit novo (em vez de remover o resto) deixa a branch à frente do commit
  verificado: a descoberta depois da cessação bloqueia (`PUBLISHED_HEAD_NOT_VERIFIED`/`REMOTE_BRANCH_CHANGED`), como no MVP. O texto da
  correção diz para apagar ou ignorar o que é descartável.
- Sem `ports.reviews.rounds` o grant da Execução é `builder-start` (leitura): o push WIP seria recusado pelo GitHub e a devolução terminaria
  em bloqueio. A composição de produção sempre tem as rodadas.
- `test/control/channel-report-flow.test.ts` (ticket 11) declarava `persistentDisk: false` num dublê que prepara checkout no host; passou a
  declarar `true`, porque um sandbox sem disco agora deve o gate ao Controle. O assunto do teste (`channelRecovery`) não mudou.

`npm run test:ci` (2026-11-21, depois do merge da ponta de `integration/software-factory-v2-lambda` com o ticket 10): 2015 testes, 1993
passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e
`test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

### Emenda de 2026-11-21 (decisão do Operador, implementada no ticket 13)

O que este Answer diz sobre três recusas seguidas (`hold` com `PRESERVATION_GATE_REFUSED`, boot não parado, Slot retido, `gateHold`) deixou de
valer. Decisão 7 do Operador: depois da terceira recusa o Controle encerra o boot na hora (Parar com motivo `loss`), grava a perda em
`work.losses[]` com `cause: 'preservation-gate-refused'` e o diagnóstico da última recusa, termina a Execução como `failure` /
`PRESERVATION_GATE_REFUSED` (agora transitório) e libera o Slot; a substituta volta pela fila consumindo uma retomada operacional.
`preservationGate` devolve `accepted` | `lost` | `stale`; `gateHold` saiu e `gateLossReason` entrou. Os cenários de três recusas e de remoto
indisponível em `test/control/preservation-gate-flow.test.ts` e o teste negativo do marcador em `test/control/loss-flow.test.ts` foram
reescritos para esse fluxo. Detalhes e limites no Answer do ticket 13.
