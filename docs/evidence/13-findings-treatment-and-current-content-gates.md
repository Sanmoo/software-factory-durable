# 13 — Tratar achados e comprovar gates sobre o conteúdo atual: incremento local

Autoridade: [ticket 13](../../.scratch/software-factory-mvp/issues/13-findings-treatment-and-current-content-gates.md),
[spec §§5.6/6.3/6.4/9.3](../../.scratch/software-factory/spec.md), [interfaces Q6](../../.scratch/software-factory/module-public-interfaces.md),
cenários V-08/V-09/V-15 da [matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).
Base: integração `2942013` (tickets 01–10, 12, 20).

**Estado: implementação e suíte local verdes (níveis R/S/I-local/H); ensaio real NÃO executado por este agente** (sem VM/modelo/GitHub/credenciais).
A receita one-shot está em [§ Ensaio real](#ensaio-real-receita-one-shot). Nenhum checkbox marcado; ticket não resolvido. Dublê não comprova fronteira substituída.

## Composição implementada

Extensão das superfícies aprovadas (Workers `activate`/`deliver`, Sandbox `observeProposal`, Control durável); sem broker, scheduler ou DI novos.
Ativada só quando a composição declara `ExecutionPorts.reviews.rounds = { max }`; sem isso o comportamento do ticket 12 (uma rodada) é idêntico.

1. **Identidade de conteúdo na captura (guest, programa constante).** `src/workers/handoff.ts` passa a gravar por entrada `headSha256`
   (blob de `HEAD` hasheado por conteúdo, via `ls-tree`/`cat-file --batch` por oid) e no resumo `content = { sha256, clean, headMatches }`:
   `sha256` sobre caminho/presença/tipo/modo/hash de cada caminho indexado (independe de índice/HEAD/refs), `clean` = nada staged/não staged/novo,
   `headMatches` = o commit `HEAD` contém exatamente o conteúdo da árvore. Campo opcional no contrato `ProposalHandoff` (capturas antigas: nenhuma isenção).
2. **Rodadas repetidas no host do Builder.** Política Host `handoff.rounds = { first, max }` (Control → facade → bootstrap, validada no schema):
   a ferramenta `handoff` aceita `gates` e `treatments`, valida-os (zod estrito, ≤ 16 KiB resolvidos) e recusa sem consumir rodada quando inválidos;
   `HANDOFF_ROUND_LIMIT` reserva a última captura para o fechamento. Os números de rodada continuam os de Execuções anteriores do Trabalho
   (`first`), pois `/artifacts/review/r<N>` é preservado e exclusivo.
3. **Evidência de gate = resultado protegido real.** `createToolLedger` (`src/workers/gates.ts`) registra cada ferramenta do Builder em ordem e,
   via novo observador de `builderBash`, o **código de saída real e a referência protegida da saída** que o owner devolveu ao host.
   Um gate `run` é resolvido pela **última chamada Bash com exatamente o comando declarado**: `passed`/`failed` pelo exit code; `unknown` se o
   resultado se perdeu (efeitos/captura desconhecidos); `unverified` (`GATE_RESULT_NOT_FOUND`) se o comando nunca rodou. Saída/estado declarados
   pelo modelo não são entrada do schema. `current=false` (`GATE_NOT_CURRENT`) quando um write/edit/outro Bash rodou depois (outros gates declarados
   excetuados). `not-run` exige motivo; `waived` exige autorização concreta (`question` respondida ou fonte preservada `/artifacts/spec|instructions/vN/...`);
   `requiredCheck` nomeia o check GitHub correspondente.
4. **Captura de fechamento.** Quando a sessão do Builder termina sem handoff pendente, o host captura mais uma vez (sem requisição ao modelo) e
   notifica `closing: true`; a diretiva pode trazer `end: true` (a ativação termina sem novo prompt) ou resultados de uma rodada forçada.
5. **Classificação pelo Control (`classifyCapture`, regra pura).** Nenhuma rodada nova **somente** quando a última rodada revisada concluiu com os
   dois pareceres completos (`clean|findings`) e aplicabilidade `current`, e a nova captura tem a mesma identidade de conteúdo, as mesmas versões de
   pedido/instruções, base, merge-base e branch, com identidade do host `observed` e `consistent`: `unchanged` (mesmo HEAD — justificativa fora da
   proposta) ou `identical-commit` (HEAD novo, árvore limpa e `headMatches`). Qualquer outra coisa — conteúdo/contexto mudado, rebase, identidade
   desconhecida/inconsistente, rodada anterior incompleta, captura antiga — é **nova rodada dos dois revisores**; aprovação antiga nunca é reaproveitada.
   A isenção é durável (`kind: 'exemption'`, `exemption {kind, reviewedRound, head, reviewedHead, contentSha256}`, revisores `not-required`).
6. **Sessões compatíveis dos revisores.** Uma rodada nova passa `review.continueFrom` = sessão do mesmo papel na última rodada revisada. O launcher do
   owner (`prepareReviewerContinuation`) só a aceita se for JSONL regular, sem link, de um perfil `w-*/profile/sessions` do **mesmo** runtime do boot,
   e a **copia** (exclusiva, 0600) para o novo perfil; o worker a abre só se for sessão `/workspace`. Caso contrário: sessão nova com motivo
   (`SESSION_NOT_IN_BOOT`, `SESSION_UNAVAILABLE`, `SESSION_UNSAFE`, `SESSION_INCOMPATIBLE`, `SESSION_OPEN_FAILED`). O parecer registra `session.mode/from/code`.
7. **Verificação no fim da Execução (`verifyExecution`, commit `recordVerification` antes de `recordEnd`).** Presença/correlação, sem semântica:
   última captura deve ser a de fechamento e disponível; os dois pareceres da última rodada revisada presentes e correlacionados (rodada, invocação,
   índice); conclusão completa e aplicável; a captura final é essa rodada ou uma isenção dela (`REVIEW_NOT_CURRENT` caso contrário); **todo achado** de
   toda rodada tem tratamento em captura posterior (`FINDING_UNTREATED`), `fixed` exige rodada posterior revisada sobre conteúdo diferente
   (`FIX_NOT_REVIEWED`), tratamento de achado inexistente (`TREATMENT_UNKNOWN_FINDING`), autorização correlacionada ao Trabalho (Pergunta respondida
   lida no mesmo commit; fonte sob a versão preservada); gates da última declaração ligados ao conteúdo final (`GATES_NOT_BOUND_TO_FINAL_CONTENT`),
   cada um `passed`+`current` ou motivo distinto (`GATE_FAILED`, `GATE_RESULT_UNKNOWN`, `GATE_RESULT_UNVERIFIED`, `GATE_NOT_CURRENT`, `GATE_NOT_RUN`,
   `WAIVER_NOT_AUTHORIZED`), e **dispensa nunca satisfaz check obrigatório** (`WAIVER_CANNOT_BYPASS_REQUIRED_CHECK`, `requiredChecks` listados para a
   prontidão GitHub). Sem gates declarados: `GATES_NOT_DECLARED`. `verified` só sem nenhum motivo. Execução encerrada por Pergunta não é verificada.
8. **Pacote `factory-skills-v4` (novo; v1–v3 intactos).** `implement` §3: gates documentados com fonte/comando/cwd rodados como últimos comandos
   (evidência só do registro do host), `not-run` + `ask_user`, dispensa só com autorização concreta e nunca para check obrigatório, tratamento de todo
   achado (heurística ≠ violação; discordância interna sem arbitragem; dúvida de requisito/dispensa/aprovação de skill → `ask_user`), novo `handoff`
   com `treatments`/`gates` até o Factory dizer que não há rodada nova. O prompt do Control acrescenta `review-rounds=multi` (também na recuperação).

## Mapa AC → evidência

Níveis: **R** regras puras; **S** Control real + Pi Durable/SQLite temporário + dublês (GitHub, relógio, Sandbox/Workers); **I-local** SDK Pi real
(laço nativo, sessão JSONL), Records/owner/transporte reais, VM `exec` e HTTP do provider dublês; **H** programa guest num repositório local de teste.

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Achado → corrigido/não acolhido com justificativa/evidência; dúvida/dispensa/aprovação → `ask user` sem autorização prévia | `gate-evidence` AC1 (schema de tratamento), `review13-rules` AC1/AC6 (não tratado, fix não revisado, achado desconhecido, autorização não correlacionada), `review13-flow` AC1/AC5 (não acolhido sem rodada nova), `review13-question-flow` AC1 (pergunta → resposta → recuperação continua a numeração → não acolhimento autorizado pela Pergunta respondida → `verified`), `skill-pack-v4` | R + I-local + S | Julgamento real do Builder (receita) |
| 2 Gates com fonte, comando/cwd, resultado/status/log reais correlacionados a conteúdo/Execução; sucesso/falha/ausência/dispensa distintos | `gate-evidence` AC2/AC3, `review-rounds-session` (exit codes reais do owner, referência protegida lida de volta, `typecheck` nunca executado → `unverified`), `review13-rules` AC2/AC3/AC6 | R + I-local | `cwd` é declarado (o processo roda em `/workspace` fixo; o comando carrega o `cd`) |
| 3 Resultado da ferramenta protegida sustenta evidência; falha/instrução faltante/impossibilidade exige orientação | `gate-evidence` (saída/exit declarados recusados pelo schema; resultado perdido = `unknown`), `review-rounds-session` (dispensa sem autorização recusada antes da captura; gate obsoleto após Bash), `review13-rules`/`review13-flow` (`GATE_NOT_RUN`, `GATE_RESULT_UNKNOWN`), `skill-pack-v4` (`not-run` + `ask_user`) | R + I-local + S | Pedido de orientação depende do modelo seguir a skill |
| 4 Proposta/contexto mudado → parecer atual dos dois; sessões compatíveis; sem reaproveitar aprovação | `review13-rules` AC4/AC5 (toda mudança de conteúdo/versões/merge-base/identidade → rodada; rodada anterior incompleta → rodada), `review13-flow` AC1 (os DOIS revisores rodam de novo, `continueFrom` das sessões da r1, parecer da r2 é novo) e AC4 (mudança sem handoff → rodada forçada no fechamento), `review-continuation` AC4 (sessão continuada: a requisição da r2 contém a conversa da r1; arquivo original intacto; fora do boot/link/ausente/incompatível → substituição registrada) | R + S + I-local | Cópia de sessão só entre lançamentos do mesmo boot |
| 5 Justificativa sem mudar contexto e commit comprovadamente idêntico não exigem rodada; correspondência/vínculo demonstrados | `handoff-content` (H: commit do conteúdo revisado mantém `content.sha256`, `clean`, `headMatches`; mudança, staged pendente e arquivo novo distinguem), `review13-rules` AC4/AC5, `review13-flow` AC1/AC5 (isenções `identical-commit` com `head`/`reviewedHead`/`contentSha256` e `unchanged`, sem ativar revisores) | H + R + S | `headMatches` vem do git do guest (cooperativo, §6.4); o host confirma hashes dos arquivos e a ref = HEAD (`consistent`) |
| 6 Controle verifica presença/correlação de pareceres, tratamentos, gates e dispensas; sem semântica; dispensa não contorna check obrigatório | `review13-rules` AC6 (todas as razões), `review13-flow` (verificação durável antes de `execution-ended`; `requiredChecks`), `review13-question-flow` | R + S | A prontidão GitHub (tickets 14/15) ainda não consome `verification` |
| 7 Provas com agentes reais: corrigido, não acolhido, rodada após mudança, commit idêntico, falha/resultado perdido; ausência ≠ sucesso | `review13-flow` AC6/AC7 (revisor falho não vira aprovação; resultado perdido; captura de fechamento falha → `end` e `not-verified`), receita `review13-qualification` (+ inércia/limites/guarda) | S + I-local | **Ensaio real a executar pelo supervisor** |

Mutações (JS compilado, restauradas; cada uma detectada): (M1) gate sempre `passed` → `gate-evidence` falha; (M2) `identical-commit` sem `clean`/`headMatches`
→ `review13-rules` falha; (M3) sem `FINDING_UNTREATED` → `review13-rules` falha; (M4) sem classificação (sempre rodada) → `review13-flow` (3) e
`review13-question-flow` falham; (M5) sessão nunca continuada → `review-continuation` (2) falha; (M6) gate nunca obsoleto → `gate-evidence` e
`review-rounds-session` falham; (M7) dispensa satisfaz check obrigatório → `review13-rules` e `review13-flow` falham; (M8) sem captura de fechamento →
`review-rounds-session` e `skill-pack-v4` falham.

## TDD observado (honesto)

Cada fatia teve o teste escrito antes da implementação correspondente, mas várias implementações foram escritas no mesmo passo antes da primeira
execução; por isso os vermelhos reais observados foram poucos: `handoff-content` (expectativa errada sobre `headMatches` com staged pendente — o
código estava certo, a asserção foi corrigida), `review13-question-flow` (hash da Pergunta no formato errado → resposta `not-applied`; e um dublê que
consumia a lista de capturas → identidade indisponível, que o Control tratou corretamente como rodada `incomplete`), o gate de arquitetura
(teste importando `platform/host` por caminho profundo) e uma asserção de ordem de histórico mal formulada. A capacidade de detecção foi confirmada
pelas mutações M1–M8.

## Decisões de interpretação e questões abertas (operador)

1. **Captura de fechamento automática.** Para provar "conteúdo atual" no fim (inclusive Builder que muda algo e termina sem handoff), o host captura
   após a sessão terminar; se o conteúdo mudou, o Control roda uma rodada forçada e entrega os resultados (a sessão continua). A última captura da
   política é reservada para isso; na última vaga os resultados são registrados e a ativação termina (`end`). Alternativa rejeitada: só observar
   identidade do host (não vê arquivo rastreado não indexado nem novo arquivo).
2. **Gate = última execução Bash com o comando exato, antes do handoff.** Correlação com o conteúdo por ordem (nada mutável depois) e pela identidade
   de conteúdo da captura em que foi declarado; o `cwd` declarado é registro documental (o processo roda em `/workspace` fixo). Commitar depois dos
   gates os torna não atuais: a skill v4 manda commitar antes e rodar os gates por último. Um commit idêntico posterior mantém os gates ligados ao
   mesmo conteúdo, mas a última declaração precisa ser atual.
3. **Confiança na prova do commit idêntico.** `headMatches`/`clean` são calculados pelo git do guest (programa constante do host, nunca do modelo);
   o host corrobora por leituras confinadas os hashes dos arquivos e que a ref da branch é o HEAD capturado. Não há verificação de objetos Git pelo
   host (packs/deltas); contra escritor hostil no guest a §6.4 já declara a captura cooperativa.
4. **Autorização concreta.** Só Pergunta Factory respondida do mesmo Trabalho ou fonte preservada sob a versão revisada; o Control verifica
   presença/correlação, nunca o conteúdo. Discordância interna com justificativa não exige pergunta; o Control não distingue semanticamente "dúvida
   de requisito" de "discordância" — isso é da skill (`ask_user`).
5. **Gate não executado ≠ dispensa ≠ sucesso.** `not-run` (sem autorização) mantém a Execução `not-verified` com `GATE_NOT_RUN:<id>`; a orientação
   concreta do operador a uma pergunta entra como **dispensa** (`waived` + autorização), que é outro estado e não vira `passed`; para um check GitHub
   obrigatório a dispensa continua insuficiente. Assim "falha não resolvida/instrução faltante/impossibilidade" fica explícito e nunca vira verde.
6. **Escopo da verificação.** Por Execução: tratamentos de achados de uma Execução anterior (antes de uma Pergunta) não são exigidos na seguinte;
   a recuperação faz sua própria rodada (a numeração continua). Execução encerrada por Pergunta não é verificada. A verificação ainda não bloqueia
   nada: publicação/prontidão (tickets 14/15) devem consumi-la; o `requiredChecks` fica para a avaliação GitHub (§9.2).
7. **Limites.** `rounds.max` conta capturas (handoffs + fechamento) por ativação; não há orçamento paralelo: os revisores usam `reviewer-v1` por ativação
   e o Builder o mesmo `builder-v1`. Nesta base o `modelBudget` de worker ainda carrega um prazo de relógio (30 min do Builder inclui as rodadas);
   a integração do ticket 19 passa a usar somente um prazo explícito do Host (não configurado em produção), e a receita mantém seus próprios limites
   (60 min, 4 capturas, ≤ 8 ativações de revisor). Na ÚLTIMA captura da política os resultados são registrados e a ativação termina (`end`): se ela
   for uma rodada com achados, o Builder não os trata nesta ativação e a verificação os reporta como não tratados (nunca sucesso), com o operador
   decidindo a continuação. Limites configuráveis de correções/recoveries são do ticket 19.
8. **Pacote `factory-skills-v4`.** Ticket 11 (paralelo) pode também precisar de nova versão do pacote; se ambos criarem `factory-skills-v4`, a
   integração precisa renumerar um deles (decisão de integração, não deste ticket).
9. **Recuperação parcial** (parecer válido + retry só do falho) continua no ticket 28: aqui um revisor falho torna a rodada `incomplete` e a próxima
   captura roda os dois de novo.

## Ensaio real (receita one-shot)

Receita: `dist/test/entrypoints/review13-qualification.js` (fonte `test/entrypoints/review13-qualification.ts`). `--plan` é inerte. Fases one-shot com
tombstone `*-intent.json` exclusivo em `$HOME/software-factory-test/y5/q13-rounds-v1/` (criado na `preflight`, `mkdir` exclusivo; existir = consumido).
Sem retry; falha grava `*-held.json`. `inspect`/`stop-environment` abrem somente uma **cópia exclusiva** do SQLite; leituras de `/artifacts` são
confinadas sem seguir links; o checkout é inspecionado por cópia bare da Factory (nunca git do host em árvore gravável pelo guest); sessões são lidas
do runtime do host com limites (16 lançamentos × 4 arquivos, 8 MiB, sem symlink).

Pré-requisitos (operador/supervisor): os mesmos do ensaio 12 (raiz `y5` 0700 com store OAuth da Factory em `credentials/` e `run/`; chave da App
copiada com criação exclusiva 0600 para `y5/credentials/app.pem` e removida ao fim; `gh`, `git`, `flock`, `qemu-img`, `systemd --user`, KVM; assets
`assets34` pin `8efa506a…`; SDKs de desenvolvimento preparados). A issue **#3** de `Sanmoo/java-springboot-event-sourcing` deve ser a **única** aberta
com `ready-for-agent`, com o texto abaixo (sintético; `plan().ticket.body`):

```text
Title: Factory smoke: document the review loop

Add a short documentation page `docs/FACTORY_SMOKE.md`. This exact upper-case file name was decided by the operator: keep it even if other docs use another naming style.

Required content:
1. A `# Factory smoke` title and one paragraph explaining that this file exists only to exercise the Software Factory review loop.
2. A `## Steps` section with a numbered list of exactly three steps: build, review, merge.
3. A `## Rollback` section saying the file can be deleted at any time without other changes.

Documentation only: the operator explicitly approves that no tests, seams or code changes are needed.

Validation (documented gate, run from the repository root `/workspace/checkout`; it must exit 0):
`test -f docs/FACTORY_SMOKE.md && grep -q '^## Steps' docs/FACTORY_SMOKE.md && grep -q '^## Rollback' docs/FACTORY_SMOKE.md`
```

**Prova opcional de "resultado perdido" com agentes reais** (mesma receita, outra storage/namespace — exige nova issue #3 com o texto acima mais
uma linha com um segundo gate documentado ("run `sleep 30` from /workspace/checkout with the bash tool timeout set to 2 seconds") e a instrução no prompt
do Builder para declará-la `run`): o host registra `exitCode: null`/`BASH_EFFECTS_OR_CAPTURE_UNKNOWN`, a declaração resolve `unknown` e a verificação
termina `not-verified` com `GATE_RESULT_UNKNOWN:<id>` — ausência/resultado perdido nunca é sucesso. O caminho principal abaixo não provoca perda de
resultado (coberta em I-local/S).

**Provocação declarada** (prompt de sistema do Builder da receita, autorizada pelo operador ao executar): a primeira proposta omite `## Rollback`
(achado de requisito do Spec plausível e o gate documentado **falha de verdade** na r1), a proposta fica sem commit até uma rodada sem achado a corrigir,
e então o Builder commita exatamente o conteúdo revisado, roda o gate por último e faz handoff (isenção `identical-commit`). Um não acolhimento é
plausível (ex.: Standards apontar o nome em maiúsculas como heurística/convenção; o Ticket fixa o nome), **não garantido**. Resultado perdido de gate
não é provocado no real (coberto em I-local/S).

```sh
NODE="env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node"
$NODE dist/test/entrypoints/review13-qualification.js --plan
$NODE dist/test/entrypoints/review13-qualification.js preflight   # GitHub somente leitura
$NODE dist/test/entrypoints/review13-qualification.js run         # efeito real: 1 VM, 1 Builder + até 4 rodadas de 2 revisores (até 60 min)
$NODE dist/test/entrypoints/review13-qualification.js inspect     # somente leitura (cópia da storage)
# se run terminar com o boot próprio possivelmente ativo (reserved/started/held, ou ended sem cessação confirmada):
$NODE dist/test/entrypoints/review13-qualification.js stop-environment
```

Efeitos e limites:

- **GitHub**: só a App. Controlador: leituras por finalidade + `repository-fetch {metadata, contents: read}`; Builder: um `builder-start {metadata, contents,
  issues: read}` (renovação por tempo do ticket 20); **revisores: nenhuma credencial**. Nenhum POST/PATCH/PUT/DELETE além de `access_tokens`. Push/PR impossíveis.
- **VM**: 1 ambiente novo, 1 boot (4096 MiB, 2 vCPU) compartilhado por todos os workers; parada pública ao fim; sem `remove`.
- **Modelo**: `openai/gpt-6-luna/openai-responses` pelo store OAuth da Factory, o mesmo para os três papéis (perfis/prompt de sistema por papel).
  Builder ≤ 60 requisições/120 ferramentas com o teto `builder-v1` (inclui as rodadas; nesta base o teto é um prazo de relógio; se a integração do
  ticket 19 mantiver apenas um prazo explícito do Host, vale o prazo da receita); até 4 capturas; **cada ativação de revisor ≤ 24 requisições/80 ferramentas
  (`reviewer-v1`)**;
  no máximo 4 rodadas × 2 revisores; total ≤ 252 requisições; retries SDK/provider 0; sem teto de cobrança no provedor (custo real desconhecido).
  Esperado: 2 rodadas de revisão (≈ 2–5 min cada, como no ensaio 12).
- **Guardas da receita**: `prepare` uma vez e só para o Trabalho #3; um Builder; por papel revisor no máximo 4 ativações de rodadas **distintas** da
  mesma Execução (`activationGuard`); prazo 60 min; ao fim o Control é parado e o estado salvo em `run-result.json` (eventos com instantes monotônicos,
  incluindo por handoff: rodada, `closing`, `content`, `head`, tratamentos e gates com outcome/exit code/current).

Observações esperadas (`run-result.json`, `inspect-result.json`):

1. `final.works[#3].execution`: `state: ended`, `slot.held: false`, `end.cessation: confirmed`; `review.firstRound: 1`; todas as rodadas `delivered`;
   a última com `closing: true`.
2. r1 `kind: review`: gate `validation` (ou id equivalente) `outcome: failed`, `exitCode: 1`, `output` com referência protegida (`inspect.rounds[0].gateOutputs`);
   provável achado `requirement` do Spec sobre `## Rollback`.
3. Rodada seguinte com `treatments` (`fixed` e eventuais `not-adopted` com justificativa) e conteúdo mudado: `kind: review`, **os dois** revisores de novo,
   `opinion.session.mode: continued` (ou `replaced` com código), gate `passed` `current`.
4. Após o commit do conteúdo revisado: rodada `kind: exemption`, `exemption.kind: identical-commit` (`head` ≠ `reviewedHead`, mesmo `contentSha256`),
   revisores `not-required`, **nenhuma** ativação de revisor para ela; captura de fechamento `exemption` entregue com `end: true`.
5. `review.verification`: `status: verified`, `reasons: []`, `applicability.kind: identical-commit` quando todo achado foi tratado e o gate passou atual
   sobre o conteúdo final; caso contrário, motivos explícitos (nunca sucesso por ausência). Histórico: `… review-exempted … review-verified → execution-ended → slot-released`.
6. Sessões dos revisores com **somente** `read`; sessão do Builder sem ferramenta entre um resultado de `handoff` e a mensagem seguinte da Factory;
   commits com a identidade **Software Factory Builder**; `tokenPattern: false`; nenhum `ghs_`/chave em `control.sqlite*` e observações (`grep -c`).
7. Resultados que exigem disposição: `held` (código em `execution.held`), Builder sem `handoff` (só a captura de fechamento → rodada forçada),
   `HANDOFF_ROUND_LIMIT`, guarda da receita (`RECIPE_ONE_SHOT_GUARD` → revisor incerto → `held`), prazo atingido.

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60`, sem npm/npx, após `rm -rf dist`; `normal-oauth`
com 90 s. Ver [§ Gate final](#gate-final).
