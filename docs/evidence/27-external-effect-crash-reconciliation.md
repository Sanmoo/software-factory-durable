# 27 — Reconciliar efeitos externos nos cortes de crash: incremento local

Autoridade: [ticket 27](../../.scratch/software-factory-mvp/issues/27-external-effect-crash-reconciliation.md),
[spec §§3.4, 5.2, 5.5, 9.1, 9.3, 10.1, 12.3](../../.scratch/software-factory/spec.md), cenários V-12/V-14 da
[matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md). Base: `integration/software-factory-mvp` @ `ec5ff1d`
(tickets 18, 21, 24, 25, 30, 31, 36–40 integrados; rebase dos commits do 27). Branch `implement/software-factory-mvp-27`.

**Estado: resolvido.** Incremento local verde e **ensaio real `q27-crashfx-v2` executado** pelo supervisor com autorização do operador
(issue #36, branch de execução `run/q27-crashfx` @ `7581f07` = estes commits sobre `ec5ff1d` + fixação do issue; v1 retido no preflight
porque ambientes do ticket 24 eram ilegíveis antes de `ec5ff1d`). Veredito original `failed` por UM oráculo da receita (ver
[§ Ensaio real v2](#ensaio-real-v2--q27-crashfx-v2-2026-11-16)); reavaliado com o oráculo corrigido sobre as mesmas evidências: `passed`.

Decisões do operador aplicadas: efeito incerto é **descoberto, nunca repetido às cegas**; sem retries implícitos; ambiguidade → operador;
autorização explícita por execução real.

## Inventário de efeitos externos

| Efeito (quem) | Intenção durável antes | Marcador "enviando" | Descoberta após crash | Lacuna encontrada → correção |
| --- | --- | --- | --- | --- |
| Comentário da Pergunta (controlador, `IssueTracker.postComment`) | Pergunta+impedimento+intenção no mesmo commit (10) | commit `begin` → `attempting` imediatamente antes do POST | marcador + autoria App (`findQuestion`); incompleta ≠ ausência; múltiplos → `conflict` | **Lacuna:** listagem completa vazia após POST possivelmente enviado voltava a `intended` e **republicava** (contra §9.1 "primeira leitura vazia não prova ausência"). **Corrigido:** novo estado `unconfirmed` (regra pura `questionDiscoveryNext`): nunca republica; a leitura segura é repetida a cada ciclo; aparição tardia → vinculada; a Pergunta continua respondível localmente (`factory answer`). |
| Registro da Pergunta (worker → controlador, ACK) | worker preserva a solicitação em Records ANTES de notificar (10) | — | **Lacuna:** ACK/notificação perdidos por crash do controlador antes do commit: a solicitação ficava só em Records (decisão 5 do ticket 10) e o boot tratava a Execução como falha comum (recovery operacional, pergunta perdida). **Corrigido:** faceta Q6 `Workers.observeQuestion` (Records, só leitura) consultada pela reconciliação de boot após cessação confirmada; solicitação íntegra é registrada com a MESMA identidade/conteúdo (`recordedFrom: records-recovery`) no commit de assentamento e liga o fim (`question`, sem cobrança); parcial/múltipla/ilegível/hash divergente **bloqueia** (`RECOVERY_BLOCKED`), nunca inventa. Regra pura `recoveredQuestionDecision`. |
| Push/criação de PR (Builder, direto) | sem intenção específica (exceção aprovada §3.4); tentativa marcada no commit de ativação com o `expectedRemote` usado (14/21) | commit de ativação | Git remoto + PR por marcador/autoria App/branch/base/OID verificado após cessação; vazia após tentativa bloqueia; PR-only uma vez (14) | sem lacuna; provas novas: interrupção com recovery pendente é assentada pela descoberta (nenhum Builder de recuperação repete); push humano por cima + restart diverge sem recaptura |
| Push com lease (Builder, 21) | `expectedRemote` explícito preservado na tentativa | idem | divergência (`lease-failed`/`after-publication`) → Pergunta; nunca recaptura | sem lacuna (teste novo com restart) |
| Conversão draft/ready (controlador, 16) | `intendConversion` | `sendingAt` | flag lida antes de tudo; enviado-mas-incerto exige autorização para repetir | sem lacuna |
| Remoção da branch remota / ambiente (controlador, 17) | `recordCleanupIntent` por recurso | — | intenção sem resultado → `indeterminate`, revalidada (DELETE atômico com `beforeOid`; Sandbox re-prova ownership); consulta falha ≠ ausência | sem lacuna |
| Emissão/revogação de token App (20) | — | — | emissão desconhecida nunca repetida automaticamente (operador) | sem lacuna |
| Boot/parada de VM (Sandbox, 26) | `current.json` antes de `systemd-run` | — | inventário + `observe`/`stop` pelo host; sobrevivente parado, nunca adotado | sem lacuna |

## Mapa AC → evidência

Níveis: **R** regras puras; **S** Control real + Pi Durable/SQLite + Records reais com dublês de GitHub/Sandbox/Builder; **S+K** idem com processo
controlador real morto por SIGKILL; **I** componente real com fronteira externa substituída; **A** ensaio real (não executado).

| AC | Testes | Nível |
| --- | --- | --- |
| 1 bateria de cortes (antes/depois de chamada/observação/commit) | Pergunta: `question-rules` "cut battery" (antes do envio = `intended` → 1 POST; após envio → só descoberta), `effects27-crash` "POST landed … killed before the result commit"; publicação: `publication-flow` AC6/HIGH 2/"ticket 27 AC2"; conversão: `readiness-flow` LOW (intenção sem envio), V-12 (enviado, crash), MED 2; remoção: `delivery-flow` AC5 crash, `github-delivery` DELETE perdido | R, S, S+K, I |
| 2 Builder sem intenção/ACK específico; descoberta após cessação | `publication-flow` "ticket 27 AC2" (interrompida com recovery pendente → vinculada, 2 ativações, `pendingRecovery` nulo), AC6, HIGH 2 | S |
| 3 intenção + resultado conhecido/indeterminado; perda de transporte ≠ ausência; leitura parcial não autoriza POST | `question-flow` "unconfirmed, never reposted", AC2 ambíguo; `question-rules` cut battery | S, R |
| 4 identidade/autoria/correlação/OID; não só nome de branch ou primeira lista vazia; múltiplos → intervenção | `question-flow` "late listing links it"; `question-rules`; `publication-flow` "ticket 27 AC7/AC4", AC6 múltiplos | S, R |
| 5 resposta no boot e ACK perdido recuperam registro/conteúdo; uma resposta; sem invenção | `effects27-crash` "lost ACK" (SIGKILL; registrada de Records com mesma identidade/conteúdo, publicada 1×, 1 resposta aceita, 2ª `QUESTION_ALREADY_ANSWERED`); `question-observation` (completa/ausente/parcial/múltipla/divergente); `question-rules` `recoveredQuestionDecision`; `question-flow` AC6/AC7 (resposta durante o boot) | S+K, I, R, S |
| 6 cleanup parcial retoma só pendentes revalidados; entrega não desfeita | `delivery-flow` AC5/AC6 (existentes, ticket 17) | S, I |
| 7 push humano concorrente/expectativa perdida bloqueiam escrita; sem recaptura/repetição após crash | `publication-flow` "ticket 27 AC7/AC4" (restart; expectativa preservada `absent`; diverge; nenhuma escrita nova); `humanchanges-flow` (21) | S |
| 8 provas reais nos cortes, sem duplicatas, inconclusivo ≠ aprovado | receita `crashfx27-qualification` (veredito `passed`/`failed`/`inconclusive`, `crashfx27-recipe-safety`); ensaio `q27-crashfx-v2`: 14/14 após a correção do oráculo | A |

TDD: os testes novos de `question-flow`/`question-rules`/`effects27-crash` foram vistos vermelhos por mutação (regra devolvendo `intended`
para listagem vazia; faceta de Pergunta desligada na reconciliação) e verdes depois. Os testes de publicação "ticket 27" passaram de
primeira: documentam comportamento já correto (sem lacuna), não uma correção.

Ajuste de teste anterior: `question-flow` "unknown outcome with a COMPLETE empty discovery reposts once" (ticket 10) passou a esperar
`unconfirmed` sem repost — mudança deliberada do comportamento aprovado no 10, pela decisão do operador e pelo AC4 deste ticket.

## Correções da revisão independente (e2af72b)

| Achado | Correção | Teste |
| --- | --- | --- |
| MED leitura transitória de Records virava bloqueio | só achado POSITIVO muda o caminho (`questionRecordFound`); indisponível/listagem incompleta → até 3 leituras e recovery operacional comum, anotado `recovery[].question = unresolved:<code>` | `effects27-flow` MED 1, `question-rules` |
| MED AC5 ponta a ponta | registro parcial → fim `failure` `QUESTION_RECORD_INCOMPLETE`, `RECOVERY_BLOCKED`, sem Pergunta/recovery | `effects27-flow` MED 2 |
| MED recusa ao vivo | `registerQuestion` grava `execution.questionRefusals` + histórico `question-refused`; o boot honra (`refused-live:<code>`) | `effects27-flow` MED 3 |
| MED parada administrativa | `interruptedEnd`: Pergunta recuperada é registrada, fim `stopped`/`ADMINISTRATIVE_STOP` com `questionId` | `effects27-flow` MED 4, `question-rules` |
| LOW fase `booted` / recibo perdido | facet consultada também em `booted`; pergunta preservada sem recibo ⇒ início incerto (`QUESTION_WITHOUT_START_RECEIPT`), nunca "não iniciou" | — (regra no commit) |
| LOW origem do histórico | `question-recorded` com `origin: records-recovery` | `effects27-flow` MED 4 |
| LOW reposts `failed` | já exigem prova de não envio no adapter (pré-envio/4xx/rate limit = conhecido; 5xx/transporte/payload = `unknown` → descoberta → `unconfirmed`) | `github-question-comments` AC2 |
| ticket 40 (rebase) | esperas dos testes novos pelo orçamento do runner (`untilHolds`), sem laço contado | — |
| ticket 21 final (rebase) | censo da receita usa o `pushViolations` exato do 21 (branch/lease/head das tentativas, remoto configurado, gh api/curl) | `crashfx27-recipe-safety` |
| LOW receita | falha de ambiente no corte A, listagem truncada (null) e censo de push limitado ⇒ `inconclusive`; `singleAnswerAccepted` conta aceitações; tracker com métodos ligados explicitamente | `crashfx27-recipe-safety` |

## Receita real

`test/entrypoints/crashfx27-qualification.ts`, namespace próprio `y5/q27-crashfx-v3` (v1 retido, v2 consumido) (raiz de acesso GitHub = o namespace; cópia da chave
de `y5/credentials/app.pem`, falha alta se ausente antes de qualquer efeito), issue sintético novo (`number: 0` recusa). Fases one-shot:
`preflight`, `ask` (filhos `a-ask` → SIGKILL logo após o POST real da Pergunta retornar, antes do commit do resultado; `b-discover-question`
→ descoberta pelo marcador, todo POST recusado pelo guarda), passo humano (resposta pelo operador), `publish` (`c-publish` → SIGKILL quando o
push do head verificado é observado na branch própria, antes da descoberta; `d-discover-publication` → vincula o PR ou uma continuação
PR-only sem push), `inspect` (comentários com marcador = 1, PRs próprios = 1, tip = head verificado, leases explícitos, ≤ 1 push do head),
`stop-environment`. Modelo real (gpt-6-luna, factory-oauth), VM real, GitHub real.

## Decisões abertas (operador)

1. **Republicação após `unconfirmed`**: não há comando para autorizar um novo POST da mesma Pergunta; hoje o caminho do operador é inspecionar
   o issue e responder localmente (`factory answer`). Um `authorize-question-republish` seria contrato novo.
2. **Falhas conhecidas da Pergunta** (GitHub recusou; nada criado) continuam repostadas até 5 vezes (ticket 10). Não há risco de duplicata,
   mas é um retry implícito; manter ou exigir autorização?
3. **Efeitos tardios durante cancelamento** (AC8, coberto após o rebase sobre o 25): um Trabalho cancelado nunca recebe POST novo (o commit
   `begin` re-verifica `result: open`), mas uma Pergunta possivelmente enviada continua DESCOBERTA (leitura segura) e é vinculada; uma
   solicitação em Records de um Trabalho cancelado nunca vira Pergunta aberta nem bloqueio (`not-recorded:WORK_CANCELLED`). Testes:
   `question-flow` "ticket 27 AC8 + ticket 25", `question-rules`. A conversão draft/ready incerta de um Trabalho cancelado não é redescoberta
   (o alvo de checks exige `open`): lacuna residual, sem risco de repetição. A receita real não inclui um corte de cancelamento.
4. Uma solicitação em Records ilegível/parcial após crash bloqueia o Trabalho (`RECOVERY_BLOCKED`) em vez de recovery operacional: conservador;
   a saída explícita (`resume`) segue sem ingresso (decisão 3 do ticket 26).

## Ensaio real v2 — `q27-crashfx-v2` (2026-11-16)

Executado pelo supervisor (autorização do operador), issue sintético #36, modelo real, VM real, GitHub real; todas as fases saíram 0;
resposta do operador `docs/FACTORY_CRASH_A.md` à Pergunta `e30daae1…`. Evidências copiadas (somente leitura; nenhum padrão de token/chave
nas cópias): [preflight](27-real-crashfx-v2-preflight-result-2026-11-16.json), [ask](27-real-crashfx-v2-ask-result-2026-11-16.json),
[publish](27-real-crashfx-v2-publish-result-2026-11-16.json), [inspect](27-real-crashfx-v2-inspect-result-2026-11-16.json),
[reavaliação](27-real-crashfx-v2-reassess-2026-11-16.json).

| Corte / prova | Observado |
| --- | --- |
| A — POST real da Pergunta retornou, SIGKILL antes do commit do resultado | `post-returned` 06:47:05.902 (`published`, comentário 6909496383) → `cut`; exit `signal:SIGKILL` |
| descoberta sem repost | `b`: `find-question` → candidatos `[6909496383]`; tentativas `[attempting, discovered]`, mesmo id; 0 `post-refused`; 1 comentário com o marcador no issue |
| uma resposta | aceita do comentário do operador; uma única `question-answered` |
| B — push do head verificado observado, SIGKILL antes da descoberta | `push-observed` `5b88249…`; exit `signal:SIGKILL`; Execução de publicação reconciliada no boot (`sandbox-stop`, cessação confirmada) |
| vínculo sem duplicata | `d`: PR draft #37 vinculado no head verificado; 1 PR próprio; tip = head; todo push com o lease exato pedido; ≤ 1 push do head |

**Por que `questionReconciled = false` (defeito da receita, não do produto).** O oráculo exigia `recovery[0]` na Execução da Pergunta,
supondo um boot sobrevivente no corte A. Mas a ativação do Builder termina no ACK da Pergunta (spec §5.5) e o controlador confirmou a
cessação AO VIVO antes de o POST retornar: `completed: question` 06:47:02.042, `stop` (cessação confirmada) 06:47:04.243, `post-returned`
06:47:05.902. A Execução já estava assentada (`end: question`, `cessation: confirmed`) quando o processo morreu; o boot seguinte não tinha
nada a reconciliar (`recovery: []`), e isso é o comportamento correto. O efeito que a AC exige reconciliar, o comentário, foi descoberto e
vinculado sem repost (`questionDiscovered`, `questionNeverReposted`, `singleQuestionComment` verdadeiros).

Correção (TDD, vermelho → verde em `crashfx27-recipe-safety`): o oráculo passa a ser `questionExecutionSettled` = fim `question` com
cessação **confirmada**, viva antes do corte ou pela reconciliação do boot (então todo registro de recovery a confirma); cessação não
confirmada continua reprovando. Reavaliação das MESMAS evidências v2 (cópia privada do storage do inspect, eventos e resultados) com o
oráculo corrigido: **`passed`, 14/14**, `inconclusive: []`.

**Sem v3.** A mudança é só no oráculo da receita (nenhum código do produto); as observações reais que ela avalia estão gravadas e foram
reavaliadas integralmente com o código corrigido; todos os demais 13 checks já eram verdadeiros no v2. Um v3 repetiria os mesmos efeitos
reais (comentário, push, PR) sem nova informação. O corte "Execução da Pergunta sobrevivente no boot" é coberto localmente com SIGKILL real
(`effects27-crash` "lost ACK" e "POST landed").

`secretShapes` = 2 no namespace: a própria cópia da chave do App (linhas BEGIN/END PRIVATE KEY), contada porque a varredura rodava antes
da remoção no `finally`; removida depois (nenhum acerto hoje no namespace nem nas cópias). A receita agora remove a cópia da chave antes de
varrer (namespace `v3`).
