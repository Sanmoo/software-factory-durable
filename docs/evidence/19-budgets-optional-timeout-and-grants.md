# 19 — Aplicar limites, timeout opcional e concessões explícitas: incremento local

Autoridade: [ticket 19](../../.scratch/software-factory-mvp/issues/19-budgets-optional-timeout-and-grants.md),
[spec §§3.2–3.4, 4.4, 5.7, 11.2–11.3, 12.1](../../.scratch/software-factory/spec.md), [interfaces Q3/Q10/Q11](../../.scratch/software-factory/module-public-interfaces.md),
[protocolo — Duração, timeout e relógios](../../.scratch/software-factory/issues/15-controller-worker-protocol.md), cenários V-06/V-13/V-15 da
[matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).
Base: integração `2942013` (tickets 01–10, 12, 20). Branch `implement/software-factory-mvp-19`.

**Estado: implementação e suíte local verdes (níveis R/S/I-local); ensaio real NÃO executado por este agente** (sem GitHub/VM/credenciais/rede/modelo).
A receita fixa está em [§ Ensaio real](#ensaio-real-receita-one-shot). Nenhum checkbox marcado; ticket não resolvido. Dublê não comprova fronteira substituída.

## Composição implementada

- **Regras puras** (`src/control/rules/budget.ts`): snapshot de limites (padrão 3/3), disponibilidade = limite + concessões − consumos − reserva
  pendente (nunca negativa), decisão de cobrança por motivo (implementação inicial: nada; correção: uma vez; continuação de correção já cobrada:
  `preserve`; recovery operacional: uma unidade), decisão de concessão, `timeoutReached` só sobre o tempo monotônico (timeout ausente ⇒ nunca),
  classificação de ultrapassagem (`not-applicable`/`within`/`proven`/`not-excludable`), impedimentos e apresentação de duração.
- **Estado durável** (Trabalho/Execução existentes; nenhum documento, ledger ou serviço novo):
  - `WorkView.budget {corrections, recoveries: {limit, granted, consumed, reserved}, source, grants[]}` — limites **capturados na admissão do
    Trabalho** a partir da configuração do repo; mudar o YAML depois não os altera (nem apaga esgotamento). `correction` (identidade estável) e
    `pendingRecovery` registram o motivo da próxima ativação.
  - `ExecutionView.charge {kind, correctionId, counter, state}` e `ExecutionView.timing {timeoutSeconds, clock: controller-monotonic, origin,
    startedAt, lastActivity, duration, timeout, overrun}`.
- **Fronteiras atômicas** (spec §3.4): *Admitir Execução* reserva no mesmo commit (ou registra esgotamento como impedimento durável
  `CORRECTION_LIMIT_REACHED`/`RECOVERY_LIMIT_REACHED` e recusa); *Confirmar início* consome **uma vez** com o recibo; `releaseBeforeStart`
  (não início comprovado: revalidação recusada antes de qualquer pedido ao worker, boot próprio cessado) libera sem consumo; qualquer hold antes do
  início (início incerto) **mantém** a reserva, que continua ocupando o orçamento. Eventos, renovações, handoffs, testes, pushes e polling nunca cobram.
- **Concessão**: `Control.accept({operation: 'grant', work_id, counter: corrections|recoveries, amount 1..100, request_id, origin: local-cli})`,
  um commit: deduplicação por identidade (mesmo conteúdo ⇒ mesmo recibo; outro ⇒ `REQUEST_ID_CONFLICT`), Trabalho aberto/vigente, `granted += n`
  com histórico antes/depois, remoção **só** do impedimento de esgotamento que ela resolve, nada lançado (a fila e a revalidação seguem).
  CLI `factory grant <work> --corrections <n> | --recoveries <n> [--request-id]` (identidade apresentada antes do envio; controlador indisponível ⇒
  `REQUEST_INDETERMINATE`, código 4; `not-applied` ⇒ código 2). O proprietário aceita o mesmo esquema.
- **Relógio e timeout** (`dispatch.ts`, tarefa de execução existente; sem scheduler/heartbeat): porta `ExecutionPorts.clock` (padrão
  `performance.now()`), separada do relógio do polling e dos timers do Pi Durable. O relógio da Execução começa na observação do recibo de início,
  com `timing.origin` = `controller_run_id` do processo que mede; `startedAt`/instantes são calendário só para apresentação. Com `timeoutSeconds`
  do repo, um timer independente de logs/atividade dorme até o limite; ao atingi-lo grava `timing.timeout` + impedimento `EXECUTION_TIMEOUT` e só
  então interrompe a atividade (sinal da ativação ⇒ canal do worker fechado) do Builder **e** dos revisores da mesma Execução; a tarefa retira as
  credenciais (`reason: timeout`, revogação de cada concessão conhecida), registra `end.outcome: timeout`, duração medida, para o boot próprio e
  libera o Slot só após cessação confirmada (incerta ⇒ Slot mantido). O Trabalho volta à mesma posição, bloqueado; nada é repetido nem ganha
  relógio novo; resposta, concessão ou restart não removem `EXECUTION_TIMEOUT`. Sem timeout configurado não há timer algum.
- **Espera externa**: o fim da ativação (pergunta) para o relógio e registra a duração medida; a Execução seguinte (continuação) tem relógio e
  `timing` próprios (sem soma por Trabalho). Se o tempo medido no fim já atingiu o limite, o timeout é registrado também (não se contorna pela espera).
- **Última atividade**: eventos observados pelo controlador (início, handoff, início de revisor, entrega da revisão, pergunta, fim) com o tempo
  monotônico da mesma origem; base da cota inferior comprovada após crash. Silêncio não é travamento.
- **Boot** (`reconcileDurations`, após `reconcileLostCredentials`, nunca numa inspeção abortada): Execução iniciada sem fim medido e sem atividade
  viva neste processo ⇒ `duration {kind: lower-bound, provenMs, calendarEstimateMs}` (estimativa de calendário explicitamente não prova); com timeout:
  cota inferior ≥ limite ⇒ `EXECUTION_TIMEOUT` (evidência `lower-bound`); caso contrário `TIMEOUT_OVERRUN_NOT_EXCLUDED` (bloqueia retomada
  automática); sem timeout ⇒ `not-applicable`, sem impedimento. Nunca compara a origem monotônica antiga com a nova; nunca vira zero; uma vez só.
- **Apresentação** (`list`/`show`, JSON da CLI): `work.limits {corrections, recoveries: {limit, granted, effectiveLimit, consumed, reserved,
  reservedBy, available, exhausted}, grants, timeout {seconds, scope: per-execution, reached, overrun}, duration {state: running|measured|
  lower-bound|unknown|not-started|not-recorded, elapsedMs (monotônico, vivo do processo que executa), lowerBoundMs, calendarEstimateMs, clock,
  startedAt, lastActivity, note}, actions [{code, nextStep}]}`. Desconhecido ⇒ `elapsedMs: null`, nunca 0. Um Trabalho com Execução encerrada e
  cessada que voltou a pendente mostra seus bloqueios, não “executing”.

## Mapa AC → evidência

Níveis: **R** regras puras; **S** Control real + Pi Durable/SQLite temporário + dublês de borda (tracker GitHub, relógios, Sandbox/Workers/credenciais);
**I-local** componentes reais com fronteira externa substituída (CLI + proprietário sob flock + socket + SQLite). **A** (real) só pelo ensaio.

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Limites separados configuráveis 3/3; reserva atômica na admissão; consumo único no início confirmado | `budget-rules` AC1/AC1-AC2/AC1-AC3; `budget-flow` AC1 (snapshot 2/1; inicial sem cobrança; reserva observada no `prepare`, antes de qualquer efeito; consumo 1× no recibo; rodadas repetidas não cobram); `entrypoints/configuration` (padrões 3/3 já existentes) | R + S | Nenhum gatilho real de correção/recovery existe antes de 22/23/26 (seams internos); ensaio observa snapshot e cobrança `none` real |
| 2 Não início libera; início incerto mantém; pergunta/continuação preservam; configuração/restart não apagam esgotamento | `budget-flow` AC2 (pausa ⇒ recusa antes da ativação ⇒ `released`, consumo 0; mesma correção depois consome 1; `WORKER_LAUNCH_UNCERTAIN` ⇒ `held`, reserva mantida e `available: 0`; nenhum substituto) e AC2 continuação (pergunta/resposta ⇒ `charge: preserved`, mesma `correctionId`, consumo 1 mesmo no limite; não é recovery; restart com YAML 5 mantém limite 1 e impedimento) | S | — |
| 3 Grant via ingresso autorizado; histórico; sem reiniciar; sem loop | `budget-flow` AC3 (quantidades inválidas recusadas; desconhecido `not-applied`; idempotência e conflito; `granted` sem tocar consumos; só o impedimento resolvido sai; reentrada pela fila; recoveries separado); `budget-flow` AC2 (esgotamento registrado 1×, nenhuma ativação em rodadas); `timeout-flow` AC4-6 (grant não contorna timeout); `entrypoints/grant-cli` (CLI real + proprietário + socket + SQLite: argumentos, offline indeterminado, recibo durável, idempotência, `request`) | R + S + I-local | `/factory grant` por comentário GitHub não implementado (decisão 6) |
| 4 Timeout opcional por repo e por Execução, incluindo comandos/revisões; sem corte de 60 min; espera externa encerra relógio sem contornar | `timeout-flow` AC4/5/6 (120 s; 119 s não corta), AC4/5 (sem timeout: 61 min monotônicos, nenhum timer), AC4 revisão (Builder **e** revisores interrompidos, sem Slot extra), AC4 espera externa (100 s medidos; 1 h de espera não conta; continuação com relógio novo: 100 + 119 s sem corte), AC4/6 pergunta após o limite (timeout mantido após a resposta) | S | Uma hora real não é exercida; ensaio real: 90 s |
| 5 Relógio monotônico local governa duração viva/timer; não compara origens; calendário é apresentação | `budget-rules` AC5/AC7; `timeout-flow` AC4/5/6 (calendário simulado +3 h e −4 h sem efeito; `elapsedMs` = 120000 monotônico; `timing.origin` = run id), crash (origem antiga nunca comparada; estimativa de calendário rotulada); `PollingClock` separado dos sleeps do Pi Durable (inalterados) | R + S | Ensaio real mede no processo real |
| 6 Timeout interrompe/bloqueia; duração comprovada/estimada/desconhecida distintas; ultrapassagem não excluível bloqueia retomada automática | `budget-rules` AC6; `timeout-flow` AC4/5/6 (interrupção, retirada/revogação antes do stop, Slot após cessação, `EXECUTION_TIMEOUT`, sem loop, restart), crash real **SIGKILL** de processo controlador filho em 3 modos (`timeout`: cota 0, `not-excludable`, `TIMEOUT_OVERRUN_NOT_EXCLUDED`; `none`: sem impedimento; `proven`: cota 130 s ⇒ `EXECUTION_TIMEOUT` `lower-bound`; antes do boot `unknown`/`null`; reconciliação única) | R + S | Liberação do Slot após crash é ticket 26 |
| 7 CLI mostra limites/reservas/consumos, duração/última atividade e ação; silêncio ≠ travamento; desconhecido ≠ zero; cancelamento acessível | `budget-flow` (view `limits` nas Works), `timeout-flow` (estado `running`/`measured`/`lower-bound`/`unknown`, `actions`), `budget-rules` AC5/7 (notas), `entrypoints/grant-cli`; `show/list --json` imprimem o `WorkView` (inclui `limits`) pelo mesmo caminho já testado | R + S + I-local | Comando `cancel` é do ticket 25 (decisão 7) |
| 8 Tempo controlado + disparo real pertinente comprovam limiar, espera, ajuste de calendário e histórico | relógio monotônico controlado (`executionClock`), calendário simulado, histórico (`timeout-reached`, `duration-reconciled`, `budget-*` exatos); disparo real: [ensaio](#ensaio-real-receita-one-shot) | S (+A pendente) | Ensaio real não executado aqui |

Mutações (JS compilado, restaurado; todas detectadas): (M1) sem consumo no `confirmStart` ⇒ 4/4 de `budget-flow` falham; (M2) timer nunca armado ⇒
4/6 de `timeout-flow` falham; (M3) sem `reconcileDurations` no boot ⇒ crash falha; (M4) fim sem marcar timeout já atingido ⇒ “pergunta após o limite”
falha; (M5) sem liberação em não início comprovado ⇒ AC2 falha.

## Correções da revisão

Revisão estática independente depois do gate inicial; cada achado com correção e teste de regressão. A revisão do supervisor não é revertida:
os pontos abaixo refinam o incremento. Nenhum checkbox marcado; ticket não resolvido.

| Achado | Correção | Teste |
| --- | --- | --- |
| FALHA de prepare/start, recusa pré-launch ou credencial retirada antes da ativação mantinha a reserva ocupando o orçamento, embora nenhum pedido ao worker existisse. | `holdExecution(..., provenNonStart)` libera a reserva sem consumo e mantém o Work sob hold/Slot; o `dispatch` distingue o que é não início comprovado (`activated` ainda falso) e, na fase de ativação, só a allowlist exata de recusas pré-launch (`WORKER_LAUNCH_INVALID`, `STALE_TOOL_CONTEXT`, `WORKER_EXECUTION_NOT_ENABLED`, `WORKER_PROFILE_NOT_CONFIGURED`, `WORKER_POLICY_ROLE_DENIED`). Qualquer outro erro na ativação mantém a reserva. | `budget-flow` “PREPARE failure …”; `budget-flow` AC2 (recusa de revalidação; `WORKER_LAUNCH_UNCERTAIN` mantém a reserva). |
| Stop do processo dono antes da ativação liberava o Slot mesmo sem cessação comprovada do boot próprio (o código não era `OWNER_STOPPED_BEFORE_ACTIVATION`, era o de revalidação). | O stop antes da ativação libera via `releaseBeforeStart(..., 'OWNER_STOPPED_BEFORE_ACTIVATION')` somente quando nada foi bootado ou a cessação é confirmada; caso contrário libera a reserva sem consumo e **mantém** o Slot sob `OWNER_STOPPED_BEFORE_ACTIVATION_CESSATION_UNCONFIRMED` (ticket 26). | `budget-flow` “owner stop before activation … unconfirmed boot cessation …”. |
| A cota inferior após crash usava só `lastActivity` e podia baixar um timeout durável já medido; o timeout medido não era uma atividade da origem. | `recordTimeout` grava `lastActivity {event: timeout-reached}`; `reconcileDurations` usa `max(lastActivity, timing.timeout.elapsedMs)` e não sobrescreve `overrun: proven` nem a evidência `measured` por `not-excludable`. | `execution-commits` “durable timeout is the last activity … never lowers the proven bound” (inclui atividade durável inferior simulada). |
| Um novo motivo em correção já aberta era perdido (mesma identidade/cobrança, sem histórico). | `openCorrection` acrescenta `correction-reason-added` (detalhe ≤ 200) quando o motivo difere do original; identidade e cobrança não mudam; cada pedido distinto fica auditado. | `budget-flow` “touching an already-open correction records the added reason …”. |
| Corte implícito do worker pelos orçamentos de modelo (`builder-v1` 30 min / `reviewer-v1` 15 min), em tensão com §4.4. A primeira correção só cobria `worker-process`; `worker-session` reintroduzia o corte e `deadlineMs` nem chegava à `Invocation`. | Nenhum worker deriva deadline de `budgetFor`/`modelBudget`: `worker-process` arma timeout somente de `bootstrap.deadlineMs` (política explícita do Host, ausente na composição de produção), encaminha o valor à `Invocation` e `worker-session` não converte mais `limits.deadlineMs` em corte de ativação. `modelBudget` segue governando requisições/ferramentas/bytes e o timeout por requisição do provedor. Import morto removido. | `workers/worker-clock-bound` (guarda estática de `worker-process` e `worker-session` + esquema: `deadlineMs` opcional, inteiro positivo ≤ 86 400 000, ausente = sem corte; `worker-start` grava o valor); `entrypoints/normal-oauth` modo `deadline` passa a fornecer a política explícita (`deadlineMs: 30000`), sem depender de corte implícito. |
| `secretScan` seguia symlink e materializava o arquivo inteiro antes de cortar 1 MiB. | Somente arquivos regulares (não symlink), teto de 5000 arquivos e leitura limitada a 1 MiB desde o início (`open`+`read`). | Helper do ensaio (`limits19`/`credential20`), sem teste de unidade dedicado; comportamento inerte já coberto por `limits19-qualification`. |

Decisões da revisão:

- **Sem corte implícito em produção.** O timeout do repositório (relógio monotônico do controlador) é o único relógio da Execução. `deadlineMs` é
  política explícita do Host e não é configurado pela composição de produção atual; `modelBudget` é envelope de requisições/ferramentas/bytes (e
  timeout por requisição do provedor), não de duração da Execução.
- **Snapshot de Trabalhos pré-19.** Um Trabalho criado antes do incremento recebe `budget` no primeiro commit de orçamento, com a configuração
  então vigente (`budget: null` até lá). É limitação documentada: não há backfill retroativo nem histórico da configuração anterior.
- **Bordas de motivo de cobrança** (múltiplas correções abertas, recovery e correção simultâneos, reabertura após consumo) pertencem aos tickets
  22/23 (reparo) e 26 (recuperação). Este incremento testa reserva/consumo/liberação/preservação e delega a sequência de reparo.
- **Não-issues confirmados:** os limites chegam ao Control por `entrypoints/configuration.ts` + `entrypoints/controller/owner.ts` (sem caminho
  paralelo); `systemClock.sleep` resolve no abort (não prende o polling); `releaseAfterCessation` grava `dispatch.phase: 'stopped'` e só libera o
  Slot com cessação confirmada.

## TDD observado (honesto)

Vermelho primeiro: `budget-rules` (módulo/tipos inexistentes — falha de compilação), `budget-flow` (seams e operação `grant` inexistentes; depois
falha real: `dispatch.reasons` vazio porque uma Execução encerrada/cessada de Trabalho de novo pendente aparecia como `executing` — corrigido na
apresentação), `timeout-flow` (falhas reais de composição de teste: o dublê adiantava o relógio antes do recibo; rejeição não observada do revisor
interrompido — corrigidos nos dublês, não no produto), `grant-cli` (vermelho confirmado com a CLI anterior: argumento recusado ⇒ código 2 em vez de 4).
O núcleo durável de orçamento passou na primeira execução após compilar: a detecção foi comprovada pelas mutações acima.

## Decisões de interpretação e questões abertas (operador/supervisor)

1. **Corte implícito dos orçamentos de modelo do worker — resolvido na revisão.** `builder-v1`/`reviewer-v1` têm `deadlineMs` de 30/15 min
   (`src/workers/oauth-qualification.ts`) como envelope de observação. Esse valor deixou de ser um corte por ativação: nenhum worker deriva
   deadline de `budgetFor`/`modelBudget`; só uma política explícita do Host (`deadlineMs`, ausente na composição de produção) limita a ativação.
   O `modelBudget` permanece como envelope de requisições/ferramentas/bytes e timeout por requisição do provedor, não de duração da Execução e não
   é teto de cobrança. Ver [Correções da revisão](#correções-da-revisão).
2. **Local do timer.** §5.7 diz que o worker host mantém o relógio desde o recibo; aqui o relógio é o da tarefa de execução do controlador (host que
   possui a Execução), iniciado na observação do recibo — mesmo processo, origem única, inclusive com Builder ocioso no handoff e revisores ativos.
   Timer no processo worker exigiria nova mensagem worker→controlador (mudança de protocolo). A latência IPC do recibo subestima a duração em
   milissegundos. Confirmar.
3. **Gatilhos de correção/recovery.** Não existem antes de 22/23 (reparos) e 26 (recuperação). Seams internos do módulo
   (`requestCorrection`/`requestRecovery` em `control/durable/control.ts`, não exportados pelo contrato público) abrem a correção (identidade estável;
   uma correção já cobrada é encerrada ao abrir outra) ou pedem recovery; a categoria/sequência de reparo da fila fica com o ticket 22.
4. **Snapshot dos limites na admissão.** “Mudar limite não apaga esgotamento nem substitui concessão” foi lido como: Trabalhos existentes mantêm os
   limites capturados; só `grant` amplia. Trabalhos anteriores a este incremento recebem o orçamento no primeiro commit de orçamento a partir da
   configuração então vigente (`budget: null` até lá).
5. **Reserva em holds antes do início.** Não início comprovado libera a reserva sem consumo: falha de prepare, falha de start, credenciais
   retiradas antes da ativação e stop do dono antes dela. Em todos esses casos o Slot só é liberado se a cessação do boot próprio for confirmada (ou
   se nada foi bootado); caso contrário o hold mantém o Slot. Erros de ativação fora da allowlist pré-launch e cessação não confirmada mantêm a
   reserva, que continua ocupando o orçamento até a recuperação do ticket 26. Ver [Correções da revisão](#correções-da-revisão).
6. **Grant por comentário GitHub** (`/factory grant`) não implementado: a ingestão de comentários só lê Trabalhos com Pergunta aberta; ampliar o custo de
   leitura para todos os Trabalhos é decisão. O ingresso autorizado aqui é a CLI local (confiança da conta administradora).
7. **Cancelamento.** O comando `cancel` é do ticket 25; nada neste incremento o bloqueia ou remove (o seam `withdrawActivityCredentials(…,'cancelled')`
   existe). A ação mostrada para timeout/esgotamento não depende dele.
8. **Desbloqueio após timeout.** `EXECUTION_TIMEOUT` só sai por decisão explícita futura (`resume`, tickets 25/26); nenhuma operação atual o remove.
   Após timeout com cessação confirmada o Slot é liberado e o Trabalho fica na mesma posição, bloqueado.
9. **Registros de revisores interrompidos.** No timeout durante a revisão os revisores não recebem `recordReviewerEnd`; a cessação confirmada do boot
   próprio cobre todos os workers do boot. Recuperação parcial de revisão é ticket 28.
10. **Cota inferior após crash.** Só eventos observados pelo controlador alimentam `lastActivity` (sem progresso de ferramenta no controlador); a cota
    comprovada pode ser pequena. Sem evidência de cessação antes do limite, com timeout configurado o resultado é `not-excludable`.
11. **Backoff 5/15/45 s** de retomadas operacionais não é deste ticket (recuperação, 26). A composição de produção ainda não tem portas de execução
    (ticket 32): o proprietário já entrega `correctionLimit/recoveryLimit/timeoutSeconds` da configuração ao Controle.

## Ensaio real (receita one-shot)

Receita: `dist/test/entrypoints/limits19-qualification.js` (fonte `test/entrypoints/limits19-qualification.ts`, provedor roteirizado
`limits19-provider.ts`). `--plan` é inerte (teste `limits19-qualification`). Fases one-shot com tombstone `*-intent.json` exclusivo em
`$HOME/software-factory-test/y5/q19-limits-v1/` (criado na `preflight`; existir = consumido). Sem retry; falha grava `*-held.json`.

**O modelo é substituído** por um provedor local roteirizado (`127.0.0.1:18719`, SSE openai-completions, mesmo padrão do 20): o worker Builder real,
a VM real e o Bash real do guest executam `c0` (listagem curta do checkout) e `c1` (`sleep 600`, timeout da ferramenta 900 s). O que o ensaio comprova
na fronteira real: o timeout de 90 s por Execução, medido no relógio monotônico do processo controlador real a partir do recibo real, interrompe um
comando real em execução; o canal do worker fecha, a concessão é retirada e auto-revogada, o boot próprio para com cessação confirmada, o Slot é
liberado e o Trabalho fica bloqueado (`EXECUTION_TIMEOUT`) através de 3 rodadas de polling, de um `grant --corrections 1` e de um restart do
Controle sobre o mesmo storage. Não comprova comportamento de modelo real nem uma hora real; reserva/consumo de correção real não é exercido (não há
gatilho de correção antes de 22/23): o orçamento é observado como snapshot (`1/0`), cobrança `none` da implementação inicial e concessão com histórico.

Pré-requisitos (operador/supervisor), como no 20: raiz `y5` privada (0700) com `credentials/` e `run/`; cópia exclusiva 0600 da chave da App em
`y5/credentials/app.pem` (remover ao fim); `gh`, `git`, `flock`, `qemu-img`, `systemd --user`, KVM; assets `assets34` (pin `8efa506a…`); SDKs de
desenvolvimento preparados; porta `127.0.0.1:18719` livre. A issue **#3** de `Sanmoo/java-springboot-event-sourcing` deve ser a **única** aberta com
`ready-for-agent` (a `preflight` exige; retirar temporariamente de outras e restaurar depois). Build: `tsc` neste HEAD.

```sh
NODE="env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node"
$NODE dist/test/entrypoints/limits19-qualification.js --plan
$NODE dist/test/entrypoints/limits19-qualification.js preflight   # GitHub somente leitura
$NODE dist/test/entrypoints/limits19-qualification.js run         # efeito real: 1 VM, 1 Builder roteirizado, ~6–8 min (prazo 15 min)
$NODE dist/test/entrypoints/limits19-qualification.js inspect     # somente leitura, sobre CÓPIA exclusiva do storage
# se run terminar com o boot próprio possivelmente ativo (reserved/started/held, ou ended sem cessação confirmada):
$NODE dist/test/entrypoints/limits19-qualification.js stop-environment
```

Efeitos e limites:

- **GitHub**: só a App da Factory e o repositório configurado. Controlador: tokens de leitura por finalidade + `repository-fetch` (Contents R,
  auto-revogado após o fetch). Builder: **uma** concessão `builder-start {metadata, contents, issues: read}` (guarda: no máximo 3 emissões; tokens de
  1 h, nenhuma renovação esperada em < 15 min), auto-revogada na retirada por timeout. Escritas: apenas `POST …/access_tokens` e
  `DELETE /installation/token`. Push/PR/issues/labels impossíveis com essas permissões. Nenhum comentário.
- **VM**: 1 ambiente novo (40 GiB qcow2 de assets34 + checkout), 1 boot (4096 MiB, 2 vCPU), parada pública pelo próprio timeout; sem
  `remove`/cleanup. `prepare` e `activate` permitidos **uma vez** e só para o Trabalho da #3 (o restart não pode relançar: guarda + impedimento).
- **Modelo**: nenhum; provedor local com no máximo 3 requisições (esperadas: 2).
- **Tempo**: timeout 90 s; amostras de duração a cada 10 s; 3 rodadas de 30 s antes e 3 depois do grant; restart + 3 rodadas; prazo 15 min.
- **Inspeção**: abre só uma cópia exclusiva 0700 do storage (`inspect-storage-copy/`), lê o recibo de início (leitura limitada, sem seguir symlink),
  conta formas de segredo; **nunca** executa git do host nem lê árvores graváveis pelo guest.

Observações esperadas (`run-result.json`, `inspect-result.json`):

1. `verdict.passed: true` com os 9 checks: `timedOutAndCeased`, `measuredOnLocalMonotonic` (`timing.timeout.evidence: measured`,
   `90000 ≤ elapsedMs < 120000`, `duration.kind: measured`, `timing.origin = runId`), `liveDurationObserved` (≥ 2 amostras `running`, relógio
   `controller-monotonic`, não decrescentes), `credentialsWithdrawnForTimeout` (`withdrawn/timeout`, `credentialIssuance.revocation: revoked`),
   `blockedWithoutLoop` (9 observações com 1 ativação e `EXECUTION_TIMEOUT`), `grantAcceptedWithoutBypass`, `budgetSnapshot` (1/0, `charge: none`),
   `timeoutRecordedOnce`, `runningCommandInterrupted` (marcador `a1-c0`, `a1-c1-end` ausente, 2 requisições ao provedor).
2. `final.works[#3]`: `execution.end {outcome: timeout, code: EXECUTION_TIMEOUT, cessation: confirmed}`, `slot.held: false`, `queue.pending: true`,
   `dispatch.reasons` ⊇ `EXECUTION_TIMEOUT`, `limits.duration.state: measured`, `limits.actions` com o texto de `EXECUTION_TIMEOUT`,
   `budget.corrections {limit 1, granted 1, consumed 0, reserved null}`, `budget.grants[0].before/after`.
3. `events`: 1 `prepare`, 1 `start`, 1 `activate` (`credentialDelivered: true`), `activation-signal-aborted`, `completion-uncertain`, 1 `revoke`
   (`revoked`), 1 `stop` com cessação confirmada, `grant` aceito; nenhum segundo `prepare`/`activate` (também após o restart).
4. `inspect-result.json` → `secretShapes`: 0 em observações, `control.sqlite*`, evidências do Trabalho e runtime do boot (exceto as chaves da CA
   MITM por boot já conhecidas do 06/20, que não são tokens).
5. Desvios que exigem disposição do operador: `verdict.passed: false` (ver `checks`), `*-held.json`, prazo atingido, `provider.held: true`, Execução
   `held`, ou `ended` com `end.cessation: unconfirmed` (Slot mantido) ⇒ usar `stop-environment`.

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 90`, sem npm/npx, após `rm -rf dist`
(HEAD `21b552a` + as alterações da revisão, ainda não commitadas no momento do gate): `dependency-cruiser` sem violações (302 módulos, 1763
dependências); `eslint . --max-warnings 0` exit 0; `tsc -p tsconfig.json` exit 0; **138 arquivos** `dist/test/**/*.test.js`, um por vez
(`--experimental-test-module-mocks --test --test-concurrency=1`, `timeout 90` por arquivo): **931 pass, 0 fail, 10 skipped, 0 cancelled**.

Os 10 skips são os mesmos de antes (host-dependentes); `test/sandbox/gondolin.test.ts` continua `skip:true`.

Novos/estendidos: `control/budget-rules` (7), `control/budget-flow` (7; +3 de regressão nesta revisão: PREPARE provado não início, motivo
adicionado em correção aberta, stop do dono com cessação não confirmada), `control/timeout-flow` (6, inclui SIGKILL real de processo controlador
filho `timing-crash-child` em 3 modos), `control/execution-commits` (4; +1 de regressão para o timeout durável como última atividade e a cota
inferior nunca reduzida), `workers/worker-clock-bound` (3, guarda estática + esquema de `deadlineMs`), `entrypoints/grant-cli` (1, I-local),
`entrypoints/limits19-qualification` (4, receita inerte/provedor/veredito).
