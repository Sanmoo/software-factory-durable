# Evidência — ticket 25: retirada de autorização, cancelamento e novos ciclos

Ticket: [25](../../.scratch/software-factory-mvp/issues/25-authorization-withdrawal-and-work-cycles.md). Spec §3.3 (invariantes 1/7/9),
§3.4, §4.1, §5.4, §11.3, §12.3. Nível desta entrega: **regras puras + fluxos storage-real** (Pi Durable/SQLite reais; GitHub, Sandbox, Workers
e relógio dublês) + **CLI/owner/protocolo reais** sem Work. A execução real (GitHub App, VM, modelo, passos humanos) tem receita pronta e
**não foi executada** (exige autorização do operador e a issue sintética).

## Desenho

- **Resultado** ganha `cancelled` e `closed-unmerged` (`WorkView.result`); tudo o que exige `open` (despacho, admissão de Execução,
  confirmação de ativação, renovação, prontidão, checks, perguntas, budget, scope) passa a recusar esses ciclos sem código novo.
- **Retirada de autorização** (`control/durable/cycles.ts` `createCycleDesk`, antes do tick do despachante): releitura completa e limitada
  (8/ciclo, LRU) do Ticket de cada Work `open`; issue fechada, label ausente, PR ou identidade divergente → impedimento
  `AUTHORIZATION_WITHDRAWN` durável + histórico; leitura indisponível não conclui nada. A revalidação do despachante grava a mesma retirada.
  A Execução ativa **não** é cortada (renovação continua permitida). Repor label/reabrir só registra `restoredObservedAt`.
- **`resume <work>`** remove só `AUTHORIZATION_WITHDRAWN`/`RESUME_REQUIRED` e põe `AUTHORIZATION_RESUME_PENDING`, que só a próxima
  leitura autorizada remove (leitura negativa re-suspende). Recusa cancelado/entregue/fechado-sem-merge; durante atividade: `EXECUTION_ACTIVE`.
- **`cancel <work>`**: um commit grava proibição (`result: cancelled`, `WORK_CANCELLED`, fila sem pendência, memória mínima do Ticket) e
  `cancellation: stopping`; depois do ACK o despachante **retira credenciais primeiro** (worker notificado, revogação tentada) e só então
  interrompe o escopo da atividade (abort SDK), grava fim `stopped/WORK_CANCELLED`, para o boot próprio e libera o Slot **apenas** com
  cessação confirmada. Cessação incerta mantém Slot; o boot seguinte (ticket 26) reconcilia sem requeue/recovery
  (`settleCancelled` em `applyConfirmedCessation`, `releaseBeforeStart`, `blockBeforeStart`, `settleInterruption`). Antes da ativação, a
  recusa ocorre antes de emitir credencial. Nada no GitHub é desfeito.
- **Merge prevalece**: o desk de entrega continua lendo o PR próprio de Works `cancelled`/`closed-unmerged`; merge confirmado → `delivered`
  mantendo `cancellation` e o histórico (`delivery-confirmed …:cancel-requested:<id>`). Publicação já tentada de Work cancelado é
  reconciliada (discovery), nunca solicitada de novo.
- **PR fechado sem merge** → `closed-unmerged` + `PULL_REQUEST_CLOSED_UNMERGED`, contadores mantidos, ciclo vigente, atividade não interrompida.
- **`reopen <work>`**: intenção durável → observação (reabertura humana dispensa escrita) → no máximo uma mutação GraphQL
  `reopenPullRequest` (grant próprio `pull-request-reopen`, Pull requests W, mesmo ponto único de GraphQL do ticket 16) → observação →
  confirmação (`result: open` + `RESUME_REQUIRED`). Resultado desconhecido observado fechado vira `not-applied`, nunca reenviado.
- **`new <owner/repo#n> [--keep-predecessor-pr]`**: só após entrega ou cancelamento `ceased` (nenhuma Execução ocupando), nunca com ciclo
  `open`/`closed-unmerged`; publicação não reconciliada recusa; PR próprio possivelmente aberto exige a flag. Decisão do supervisor: leitura
  fresca do Ticket ao aceitar; recusa `TICKET_NOT_AUTHORIZED` (sem label/fechada) ou `AUTHORIZATION_READ_UNAVAILABLE`. Cria Work `cycle+1`
  com `predecessor`, budget/branch/ambiente próprios, índice/memória no mesmo commit, aguardando `DEPENDENCIES_NOT_EVALUATED`.

### Correções da revisão independente (56d7725)

- Merge do PR mantido de um predecessor cancelado (não corrente) entrega esse predecessor; toda leitura avança `lastReadAt`; predecessor
  com PR observado fechado deixa de ser lido.
- Só fechamento da issue ou ausência da label (leitura completa) retiram autorização; identidade divergente, PR, leitura indisponível são
  transitórios (nada durável). `AUTHORIZATION_RESUME_PENDING` só sai com leitura iniciada depois do commit do resume.
- Publicação: Work cancelado/`closed-unmerged` só reconcilia publicação já tentada (discovery); avaliação/solicitação recusadas no commit.
- Reopen: resposta `applied` é a evidência primária; leitura contrária fica incerta (re-lida), nunca `not-applied`. Cancel antes do envio
  liquida sem enviar (re-checado no commit de envio); depois do envio, o efeito é reconciliado sem reviver o ciclo.
- Cancel antes da ativação: boot próprio parado, Slot só com cessação confirmada (teste de fluxo para os dois casos).

## AC → testes

| AC | Cobertura |
| --- | --- |
| 1 retirada/reposição | `test/control/cycles-flow.test.ts` (label removida durante atividade real-Control, atividade conclui, reposição não basta, resume + leitura); `cycles-commits.test.ts` (fechamento, leitura indisponível, resume re-suspenso); `cycles-rules.test.ts`; `question-flow.test.ts` atualizado |
| 2 cancelamento | `cycles-flow.test.ts` (ordem: withdraw-credential/revoke antes do abort; Slot mantido sem cessação, liberado após restart); `cycles-commits.test.ts` (boot reconcilia sem recovery) |
| 3 efeitos enviados / merge prevalece | `cycles-commits.test.ts` (merge durante cancelamento → delivered com histórico); `cycles-flow.test.ts` (só leituras GitHub) |
| 4 PR fechado sem merge | `cycles-commits.test.ts`; `delivery-flow.test.ts` (atividade não interrompida; merge posterior entrega) |
| 5 reopen | `cycles-commits.test.ts` (unknown→not-applied sem reenvio; aplicado e observado; nada concedido) |
| 6 new | `cycles-commits.test.ts`, `cycles-flow.test.ts` (novo ciclo despachado com branch própria), `cycles-rules.test.ts` |
| 7 sem redisparo | `cycles-flow.test.ts` (polling/restart/comandos tardios), `cycles-commits.test.ts` (`admitTicket` → existing, impedimento alheio preservado) |
| 8 CLI/GitHub/processos | `test/entrypoints/update-scope-cli.test.ts` (CLI+owner+socket reais para cancel/resume/reopen/new); `publication-boundary.test.ts` (única mutação nova); receita real abaixo |

## Receita real (não executada)

`test/entrypoints/cancel25-qualification.ts`, namespace `/home/sanmoo/software-factory-test/y5/q25-cancel-v1`, raiz de acesso GitHub
própria (cópia da chave `y5/credentials/app.pem`, falha alta se ausente). `--plan`/import inertes; tombstones; `phaseGuard`; gh atrás de
wrapper (só GET e `DELETE /installation/token`); tracker/CodeRepository sem escrita. Fases: `preflight` → `run` → `new` → `inspect`
(+ `stop-environment`). A issue sintética (título/corpo fixados em `syntheticTicket`) é criada pelo supervisor após autorização e o número
é fixado em commit; sem isso toda fase real recusa `TICKET_NOT_PINNED`. Passos humanos em `run`: remover a label, recolocá-la e o supervisor
rodar o **CLI real** (`cancelCommand`: `node dist/src/entrypoints/cli.js cancel <work> --root …/q25-cancel-v1 --request-id q25-cancel-1 --json`)
contra o socket do owner da receita (`serveControl`, o mesmo handler do controlador, extraído para `src/entrypoints/controller/serve.ts`)
enquanto `./mvnw -B verify` roda. Cópia da chave só após o tombstone do preflight; removida só no `finally` do `inspect`. Lacuna (decisão do
supervisor): merge concorrente/fechamento/reopen reais ficam no nível de fluxo e serão cobertos numa jornada real posterior.
