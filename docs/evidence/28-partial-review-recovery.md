# 28 — Recuperar revisão parcial sem perder parecer válido: incremento local

Autoridade: [ticket 28](../../.scratch/software-factory-mvp/issues/28-partial-review-recovery.md),
[spec §§4.4/5.3/5.6/6.1/6.4](../../.scratch/software-factory/spec.md), [interfaces Q6](../../.scratch/software-factory/module-public-interfaces.md),
cenários V-08/V-12/V-13 da [matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).
Base: integração `d4483d1` (tickets 01–13, 19, 20, 32). Depende de 26 (em `implement/software-factory-mvp-26`, ainda não integrado):
o código de 26 foi lido em `1bd8d36` (somente leitura) e o desenho compõe com ele; o rebase sobre 26 fica para quando 26 integrar.

**Estado: implementação e suíte local verdes (níveis R/S/I-local); ensaio real NÃO executado por este agente** (sem VM/modelo/GitHub/
credenciais). Receita one-shot em [§ Ensaio real](#ensaio-real-receita-one-shot). Nenhum checkbox marcado; ticket não resolvido.
Dublê não comprova fronteira substituída.

## Composição implementada

Ativada só quando a composição declara `ExecutionPorts.reviews.partialRecovery = true` (a composição de produção declara);
sem isso o comportamento dos tickets 12/13 (nenhum retry de revisor) é idêntico e os testes deles ficam inalterados.

1. **Records.find (de 26, byte a byte).** `src/records/index.ts` foi copiado de `implement/software-factory-mvp-26@1bd8d36` (listagem por
   correlação; ausência só com raiz íntegra; parcial/corrompido → `incomplete`). No rebase sobre 26 o conteúdo é idêntico.
2. **Workers.observeOpinion (faceta Q6 `observe`, novo).** `src/workers/opinion-observation.ts`: lista no Records protegido os registros
   `callId=review-opinion` da invocação; só um registro **completo** (`complete.json`), íntegro, correlacionado (work/execução/invocação/callId) e
   válido no `opinionSchema` é parecer; listagem completa sem registro = `absent`; parcial/múltiplo/corrompido/de outra invocação = `uncertain`.
   Não prova cessação. Exposto em `ExecutionPorts.workers.observeOpinion?` e composto em produção.
3. **Regras puras** `src/control/rules/review-recovery.ts`:
   - `retryDecision`: re-obter **só** o revisor falho exige cessação conhecida (`completion-observed`/`never-started`), falha transitória
     (modelo/transporte/worker/veredito inválido/`OPINION_MISSING`; configuração, autorização, correlação e integridade nunca), identidade da proposta
     **re-observada igual** à do início da rodada (sha + índice, consistente) e uma unidade do contador **existente** `recoveries` do Trabalho
     (concessões contam). Parecer `incomplete` é resultado real e nunca é re-obtido. Espera persistida 5/15/45 s pelo consumido (mesma tabela de
     26 `recoveryWaitsSeconds`; delega a `recoveryWait` no rebase).
   - `incorporable`: registro descoberto vale só para exatamente papel/rodada/tentativa/invocação/índice pedidos.
   - `carryPlan`/`carrySource`/`undiscovered`: a primeira rodada de uma Execução de recuperação (26: `execution.interruption.reason =
     OPERATIONAL_RECOVERY`, cessação da anterior confirmada) leva os pareceres válidos da última rodada interrompida — gravados ou **descobertos**
     no Records para revisores sem desfecho registrado — **somente** com a mesma proposta e contexto (`sameProposal`, extraído de `classifyCapture`:
     conteúdo, versões de pedido/instruções, base, merge-base, branch, identidade observada consistente) e mesmo pacote/perfil de revisor.
     Qualquer mudança: nada é levado, os dois revisores dão parecer novo (sem equivalência semântica).
   - `opinionCorrelated` (em `rules/review.ts`): a verificação do ticket 13 aceita um parecer levado só pela proveniência e sobre o mesmo conteúdo.
   - `preservedReviewContext`: estado de revisão preservado para a sessão substituta (contexto apenas; entrega ≠ consumo).
4. **Commits duráveis** `src/control/durable/review-recovery.ts` + ajustes mínimos em `durable/review.ts`:
   `recordReviewerRetry` (um commit: tentativa anterior em `attempts[]`, nova identidade `role-exec-rRaN`, hash do prompt, espera persistida
   `retry.notBefore`, reserva `recoveries.reserved = invocação`, re-checada contra o orçamento durável), `recordNotRetried` (motivo explícito);
   `recordReviewerStart` consome a reserva com o recibo; `recordReviewerEnd` libera em não início comprovado, verifica `attempt` e grava `source`;
   `recordConclusion` acrescenta `ROLE_NOT_RETRIED:<code>`; `recordHandoff` aceita `carried` (estado `ended`, `source: carried`, proveniência).
5. **Dispatch** (`reviewRound`): Builder segue suspenso; cada papel roda `attempt → decisão → (intenção durável → espera no relógio da Execução →
   nova tentativa)`; o outro parecer não é tocado; conclusão/entrega só depois de ambos encerrarem. Conclusão sem parecer → busca no Records
   (uma vez) antes de registrar falha. Cessação não confirmada continua no caminho de hold (26 recupera pela fila, sem adotar sobreviventes).

Novos campos opcionais em `ReviewerView` (`attempt`, `attempts`, `source`, `carried`, `charge`, `retry`, `notRetried`); eventos de histórico
`reviewer-retried`/`reviewer-not-retried`/`opinion-carried`. Registros anteriores sem esses campos = tentativa 1 por notificação.

## Correções da revisão estática independente (sobre `e9295ab`, TDD vermelho→verde em `3e7537c`)

Vermelho observado: os testes novos foram compilados contra `src` de `e9295ab` (4 fluxos, 1 de pergunta, 1 de paging falharam; o teste de
regras falhou já na importação dos novos símbolos) e depois verdes com a correção.

- **HIGH 1 reserva presa**: retry registrado e nunca lançado (interrupção/parada na espera, proposta mudou antes do lançamento, falha antes do
  `activate`) = não início comprovado → `releaseReviewerRetry` libera a reserva (também com a Execução já encerrada); `execute` aguarda o laço
  de revisão antes de registrar timeout/parada. Início incerto mantém. `settleReviewerReservations` (recibo consome uma vez, ausência após
  cessação libera, incerteza mantém) para a reconciliação de 26 (chamada no rebase). Testes: fluxo "interrupted during the persisted wait",
  regras "reconciliation settles".
- **HIGH 2 perfil do carry**: identidade normalizada do pacote (nome sem `factory/skill-pack/` + manifesto; id sem manifesto nunca casa) e
  campos de política do revisor; `reviewProfile` única para a rodada gravada e o carry. Teste com as formas de produção (seed de `prepare`,
  ordem de chaves, prefixo, string).
- **MED 3**: retries da mesma rodada serializados sobre a reserva única (5 depois 15 s), nunca descartados como `BUSY`.
- **MED 4**: `preservedReviewContext` (sem carry) no prompt substituto após resposta (`KnownContext.review`, primeiro a cair no limite);
  teste em `review13-question-flow` (parametrizado; sem `partialRecovery` o prompt é idêntico).
- **MED 5**: tipagem de `interruption` e teste de fluxo do corte no handoff **ficam para o rebase sobre 26** (não integrado; instrução do supervisor).
- **MED 6**: `Promise.allSettled`; falha de um laço de recuperação não abandona o irmão; hold `REVIEWER_RECOVERY_FAILED` (ou o hold de cessação).
- **LOW**: identidade re-observada logo antes do lançamento; observação do Host só para papel falho; leitura do registro em todas as páginas
  (≤ 256 KiB, sem laço sem progresso); um handle de Records por facade (aberto uma vez); `incomplete` nunca levado; receita: inspect sobre
  cópia privada do Records, recusas da guarda como `WORKER_LAUNCH_INVALID` (never-started, liberado, não transitório) e no máximo 2.

## Mapa AC → evidência

| AC | Testes | Nível |
| --- | --- | --- |
| 1 notificação perdida localizada/incorporada uma vez | `review28-flow` "lost notification…"; `opinion-observation` (Records real); `review28-rules` incorporable/carryPlan descoberto | S + I-local (Records real); entre Execuções: R (fluxo só após rebase em 26) |
| 2 parcial ≠ parecer; ausência/falha/cancelamento explícitos | `opinion-observation` (parcial/múltiplo/inválido); `review28-flow` "unreadable record"; `review28-rules` failure/cancelled | I-local + S + R |
| 3 preserva válido, recupera só o falho; mudança → dois novos | `review28-flow` AC3/AC4/AC5 e "changed proposal"; `review28-rules` carryPlan mudanças | S + R |
| 4 limites existentes, sem orçamento paralelo; interrupção pela fila | `review28-flow` budget/esperas/exaustão/não transitória; fila sem sobrevivente = 26 | S; parte de fila: 26 |
| 5 Builder sem turnos até cessar revisores | `review28-flow` ordem entrega × fins; tickets 12/13 (suspensão no host) | S (+ H dos tickets 12/13) |
| 6 entrega ≠ consumo; continuação reconstruída sem duplicar | `review28-rules` preservedReviewContext; carry de pareceres na rodada nova (tratamento referencia a rodada nova) | R; fiação no prompt substituto de 26 pendente do rebase |
| 7 provas reais | receita `review28-qualification.ts` (inerte testada) | **não executada** |

## Decisões de interpretação e questões abertas (operador)

1. **Retry dentro da Execução consome `recoveries`** (o "limite operacional existente"). Não há teto por rodada além do orçamento e do
   `attempt ≤ 9` do schema: falhas determinísticas repetidas podem esgotar a reserva de recuperações do Trabalho. Alternativa: 1 retry por
   papel/rodada. Exaustão não cria impedimento do Trabalho (a Execução continua; a falha real é entregue e a verificação reprova).
2. **Lista de falhas transitórias** (whitelist em `rules/review-recovery.ts`) inclui veredito inválido do modelo; códigos de sessão/perfil não.
3. **Perda de notificação com canal fechado dentro da Execução** não tem como confirmar a cessação de um revisor isolado (não há observação por
   invocação): mantém o hold `REVIEWER_CESSATION_UNCONFIRMED` e segue a recuperação de 26 (parada do boot = cessação), depois o carry com descoberta.
4. **Carry só após `OPERATIONAL_RECOVERY`** (não após resposta/escopo: pode mudar contexto). Lido estruturalmente de `execution.interruption`
   até o rebase sobre 26 (sem efeito antes dele).
5. **Pendentes do rebase sobre 26**: delegar a espera a `recoveryWait`; incluir `preservedReviewContext` (com carry) no
   `interruptionRecoveryPrompt`; chamar `settleReviewerReservations` em `settleInterruption` com `observeStart` por invocação de retry;
   tipar `interruption`; teste de fluxo do corte de controlador no handoff (carry + descoberta); unificar `observeOpinion`/`observeStart`.

## Ensaio real (receita one-shot)

`test/entrypoints/review28-qualification.ts` (import e `--plan` inertes, testados). Fases `preflight`, `run`, `inspect`, `stop-environment`
(tombstone exclusivo; nunca reexecuta). Observações em `/home/sanmoo/software-factory-test/y5/q28-partial-v1`. GitHub só leitura (Ticket #3
sintético em `Sanmoo/java-springboot-event-sourcing`), 1 VM, modelo real `openai/gpt-6-luna` via factory-oauth, retries de SDK/provider 0.

Provocações declaradas: (1) Spec r1a1 com `deadlineMs` 20 s do Host (worker real interrompido pelo próprio prazo, parecer `cancelled`
preservado) → Control re-obtém só Spec a2 após 5 s; (2) a conclusão de Standards r1a1 chega ao Control sem o parecer (hop do facade) → Control
localiza o parecer real no Records real, sem rerodar. O Builder mantém a provocação do 13 (omite `## Rollback`) → rodada posterior com
conteúdo mudado → os dois revisores de novo.

Limites: Builder ≤ 60 requisições; revisores ≤ 24 cada; ativações Standards ≤ 4, Spec ≤ 5 (um retry só na r1); **total ≤ 276 requisições**;
prazo 75 min. Guarda: um Builder; (rodada, tentativa) distintas; Standards nunca re-tentado.

```sh
cd /home/sanmoo/dev/github.com/Sanmoo/software-factory-durable   # árvore com o ticket 28 compilado em dist/
N="env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node"
$N dist/test/entrypoints/review28-qualification.js --plan
$N dist/test/entrypoints/review28-qualification.js preflight
$N dist/test/entrypoints/review28-qualification.js run
$N dist/test/entrypoints/review28-qualification.js inspect
# só se run terminar com o boot próprio possivelmente ativo:
$N dist/test/entrypoints/review28-qualification.js stop-environment
```

Observações esperadas (`inspect-result.json`): r1 `standards.source = records-discovery`, sem segunda ativação de Standards na r1;
`spec.attempts[0]` cancelado `REVIEWER_INTERRUPTED` (ou falha `WORKER_*` com `completion-observed`), `spec.attempt = 2`,
`retry.waitSeconds = 5`, `charge.state = consumed`, `budget.recoveries.consumed = 1`, `reserved = null`, entrega da r1 depois dos dois fins;
rodada com conteúdo mudado com as duas ativações `a1`; Execução `ended`, Slot liberado com cessação confirmada; sem token nos artefatos.
Se Spec r1a1 terminar `REVIEWER_OUTCOME_UNCERTAIN` (canal fechado pelo prazo), a Execução fica `held` `REVIEWER_CESSATION_UNCONFIRMED`
sem retry — registrar como achado. **Fora desta revisão**: corte do controlador no handoff (exige a recuperação de 26 na composição; padrão
`recovery26-qualification.ts` com filhos sob `flock` e SIGKILL) — proposta de `q28-partial-v2` após o rebase.

## Gate local

Sobre `d4483d1` + commits do ticket 28 (Node 24.21.0, comandos exatos do briefing, sem npm/npx):
`tsc -p tsconfig.json` 0 erros; `eslint . --max-warnings 0` limpo; `dependency-cruiser` sem violações (348 módulos, 2118 dependências);
`prepare:sdk` (sdk-profile + gondolin-sdk-profile) ok; **166 arquivos `dist/test/**/*.test.js`, um por vez** (`--experimental-test-module-mocks
--test --test-concurrency=1`): **1051 pass, 0 fail, 10 skipped** (`test/sandbox/gondolin.test.ts` continua `skip: true`).
Novos: `review28-rules` 5, `review28-flow` 5, `opinion-observation` 1, `review28-qualification` 3; tickets 12/13 inalterados e verdes.

Após as correções da revisão (`3e7537c`): tsc 0 erros, eslint limpo, dependency-cruiser sem violações (348 módulos, 2122 dependências);
166 arquivos um por vez: **1060 pass, 0 fail, 10 skipped** — `entrypoints/admission-cli` e `workers/sdk-profile` falharam sob carga
paralela de outros gates e passaram ao rerodar sozinhos (flakes conhecidos). Novos: `review28-rules` 8, `review28-flow` 9,
`opinion-observation` 2, `review13-question-flow` 2 (1 novo), `review28-qualification` 3.
