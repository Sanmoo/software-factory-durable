# 37: Otimizações dirigidas da suíte de testes

**What to build:** Cortar os desperdícios medidos da suíte sem perder cobertura, em vez de uma auditoria completa dos ~1100 testes. A auditoria geral de redundância só volta a ser avaliada se `npm run test:ci` passar de 6 min nesta máquina.

**Blocked by:** [36: Runner de testes em camadas, paralelo e com lock da máquina](36-tiered-parallel-test-runner.md)

**Type:** task

**Status:** resolved

## Alvos medidos (a2f0a76, 2026-11-15)

1. `entrypoints/normal-oauth` (55,5 s): esperas reais — modo `deadline` com `deadlineMs: 30_000` e `held-ack` com o timeout de ACK fixo de 5000 ms em `src/workers/worker-process.ts:148`. Tornar o timeout de ACK injetável (sem mudar o padrão de produção) e usar prazos curtos ou relógio falso. Ganho estimado ~35 s.
2. Três arquivos de release (`release-install`, `release-artifact`, `release-upgrade`, 74,5 s) constroem uma release completa cada um no seu `before`; compartilhar um build por execução (ganho ~20 s).
3. `architecture-gate` (19 s) cria um processo de depcruise/eslint por regra; uma execução com todas as regras.
4. Nove arquivos de fork do adaptador (`normal-*`, `public-*`, `owner-registration`, `adapter-diagnostics`; 111 s, 26% do serial): cada modo sobe uma cadeia adaptador → owner → worker Node 24 nova. Consolidar modos numa cadeia reutilizada onde o isolamento não é o que está sendo provado.
5. Seis arquivos de crash sobrepostos em "SIGKILL do controlador e reinício na mesma storage" (30 s): manter um cenário real representativo por mecanismo e mover variações para testes de regra pura.

## Acceptance criteria

- [x] Cada alvo tem antes/depois medido pelo runner do ticket 36.
- [x] Toda remoção ou fusão de teste é proposta numa tabela (teste, motivo, AC/achado de revisão que continua coberto e por qual teste) e só é aplicada após aprovação explícita do operador, em lote.
- [x] Nunca remover o único teste de um AC ou de um achado de revisão.
- [x] Mudança de produto limitada a tornar injetável o que hoje é fixo (ex.: timeout de ACK), com padrão de produção inalterado e testado.
- [x] `npm run test:ci` verde, dentro do teto, três vezes seguidas; tempo total registrado no ticket.

## Autorização e limites

Sem rede, GitHub, VM, modelo ou credenciais. Remoções dependem de aprovação do operador.

## Comments

- 2026-11-15 (ticket 36): `entrypoints/admission-cli` está em **quarentena** em `test/tiers.json` (não é
  cobertura): controlador real com polling de 1 s; `list` no meio de um ciclo vê `DEPENDENCIES_NOT_CURRENT`.
  Falhou em 4 de 6 execuções de `ci` (lane paralela e serial) e em 1 de 4 execuções isoladas (carga entre 1 e 10);
  ao falhar deixa o controlador vivo e o processo do arquivo não termina. Tem ainda `timeout: 45000` fixo.
  `sandbox/bash-credential` ficou `serial`: o teste do AC2 espera 20 ms fixos por um comando em voo e falhou
  1 vez em paralelo. Corrigir ambos com evento/relógio injetado e remover as entradas. Também ficam em `fast` arquivos com crash/SIGKILL reais
  (`control/recovery-crash`, `control/credential-lifecycle`, `control/timeout-flow`,
  `entrypoints/control-public`, `entrypoints/upgrade`): consolidar conforme o alvo 5 e a regra de
  `docs/agents/testing.md`. Em `full`, `sandbox/sandbox-storage` falha de forma determinística
  (`observe().cessationConfirmed` é `true`; o teste espera `false`), visto pela primeira vez porque antes ficava
  sempre pulado: precisa de ticket próprio (deriva entre teste e produto), não de quarentena.

- 2026-11-15 (ticket 17 implementer, por instrução do supervisor): `entrypoints/normal-worker` entrou em quarentena (`test/tiers.json`, ticket 37). Ele tem um `timeout: 15000` fixo no próprio teste, sobre uma cadeia inteira adapter→owner→worker Node24. Expirou em 2 de 2 execuções de `ci` (carga 11-19, `ERR_TEST_FAILURE`, cancelado) e passou sozinho (1/1).
  Na mesma janela, `workers/public-copy-read` falhou 1 vez (`spawnSync … ETIMEDOUT`, `timeout: 25000` fixo no `spawnSync`). Ele reapareceu na execução seguinte (2 de 3 `ci`) e também entrou em quarentena.
  Na execução seguinte, `entrypoints/publication-composition` (do ticket 14) também falhou. Ele espera `publication.state === 'published'` com um laço fixo de 600 × 10 ms e ainda estava em `awaiting-discovery` após 15,9 s, com carga 10-20. Passa sozinho em 5,6 s. Também entrou em quarentena.
  Instruções de correção, para os dois e para qualquer timer fixo nas camadas `fast`/`ci`:
  1. Remover o `timeout` fixo de `test(...)` e de `spawnSync`, e os laços de espera com contagem fixa (600 × 10 ms).
  2. Sincronizar por eventos observáveis: mensagens `worker-message` / `worker-exit` e o fim do filho, com `spawn` assíncrono e `once('exit')` em vez de `spawnSync`.
  3. Se um limite for indispensável contra travamento, injetá-lo, derivado de um orçamento relativo informado pelo runner (por exemplo, uma variável de ambiente com o teto da camada dividido pelo número de arquivos da lane). Nunca uma constante de 15 s ou 25 s.
  4. Ao estourar, o teste falha com a etapa em que parou e mata a árvore de processos, para não vazar filhos.
  5. Depois da correção, remover a entrada de quarentena e comprovar 3 execuções verdes de `ci` sob carga.

- 2026-11-15 (ticket 37 implementer): **proposta de remoção/fusão — aguarda aprovação do operador, NADA aplicado.**
  Tudo o que só acelera sem tirar cobertura já foi commitado (ver comentário de medição abaixo). Os alvos 4 e 5 mudam
  isolamento ou trocam um crash real por estado montado, então entram aqui. Cada linha é aplicável isoladamente.

  | # | Teste(s) | Proposta | Motivo | AC/achado que continua coberto, e por qual teste | Ganho estimado (ci) |
  | --- | --- | --- | --- | --- | --- |
  | P1 | `normal-oauth`: modos `success`, `third-request`, `second-tool`, `http429`, `http500`, `mutable-error`, `provider-bytes`, `prompt-bytes`, `tool-args-overflow`, `tool-result-overflow`, `context-bytes` (11) | Continuam 11 `test()`, mas compartilham **um** boot de adapter→owner (`before`), com uma ativação (worker Node24 nova) por teste. Exige o fixture de diagnóstico ler o modo por ativação, e não por processo | Variam só a resposta do provider; o que se prova é o tratamento no worker, não o isolamento do owner. O worker continua novo a cada ativação | Mesmas asserções por modo, no mesmo teste. Os modos que travam/revogam o owner (`held-ack`, `rotation-ack-fail`, `start-failure`, `prompt-secret`, `missing-store`, `abort`, `deadline`) continuam com cadeia própria | ~0,6 s de boot × 11 sozinho; ~15 s na lane |
  | P2 | `normal-edit`: `complete`, `mismatch`, `no-match`, `empty`, `budget` (5) | Mesmo desenho de P1: um boot compartilhado, uma ativação por teste | Variam a edição pedida, não o owner | Mesmas asserções por modo. Os modos que revogam ou deixam incerteza (`uncertain`, `persist`, `cancel`, `eof`, `secret`) e `invalid` continuam isolados | ~3 s sozinho; ~8 s na lane |
  | P3 | `normal-edit`: `absent`, `standards`, `spec` (3) | **Fusão** num teste que faz as três ativações (Edit desligado: sem budget, e os dois papéis revisores) numa cadeia | Os três provam a mesma propriedade (ferramenta Edit ausente → só Read), com três boots | As mesmas asserções por ativação, dentro do teste fundido. A política de papel também está em `workers/native-builder-edit` ("role/preflight denial is ZERO RPC") | ~2 s sozinho; ~5 s na lane |
  | P4 | `control/recovery-crash`: cortes `receipt`, `reservation`, `question` (AC3/AC4) | Trocar o SIGKILL real por estado de crash montado direto no storage (`openStore` + os mesmos registros que o filho grava até o `CUT`), seguido do mesmo `reopen` | É o mesmo mecanismo ("SIGKILL do controlador e reinício na mesma storage") dos cortes `tool` e `spawn`, que ficam reais. O que varia é o ponto de corte, que é estado durável | O mecanismo real fica em `tool cut` (AC1/AC2/AC8) e `spawn cut` (AC3, cessação antes do substituto), e também em `review28-crash` e `controller-ownership` (SIGKILL + lock). AC3 receipt/reservation e AC4 question continuam com as mesmas asserções sobre o estado reconciliado | ~3 s |
  | P5 | `entrypoints/upgrade`: "real SIGKILL after each durable step" (3 cortes: `journal`, `migrated`, `selected`) | Manter o corte `migrated` com SIGKILL real. `journal` e `selected` viram journal/arquivos montados no estado do corte, com as mesmas asserções de resume/rollback | Um cenário real por mecanismo (testing.md). Os outros dois são variações do ponto de corte | O mecanismo fica no corte `migrated` real. A recusa do launcher (`UPGRADE_INCOMPLETE`) e o resume/rollback por corte continuam com as mesmas asserções | ~3 s |
  | — | `timeout-flow` (crash AC5/AC6), `credential-lifecycle` (AC6, review 4), `control-public` (descritor do lock), `controller-ownership` | **Sem proposta.** Cada um é o único crash real do seu mecanismo (durações após crash, grant perdido, herança do descritor, liberação do flock) | — | — | — |

  Total proposto: 5 itens. Mudam o isolamento de 16 testes (P1, P2), fundem 3 em 1 (P3) e trocam 5 crashes reais por estado montado (P4, P5).
  Nenhum é o único teste de um AC ou achado. Economia estimada de ~35 s de lane no `ci` (~15 s em serial).
  Nada disso é necessário para o teto: o `ci` já fica bem abaixo de 6 min, então a auditoria geral também não volta.

- 2026-11-15 (ticket 37 implementer): **medição e estado.** Antes: `ci` em 9ca7bfa com 4 arquivos em quarentena, total
  209,3 s, lane paralela 192,0 s, carga inicial 8,7. Depois: rebase sobre b88bcec, HEAD com os commits do ticket 37,
  **três `ci` verdes seguidos**: 262,9 s, 239,7 s e 208,6 s de 600 s. A carga inicial foi 10,8, 16,4 e 12,8 (outras
  sessões em paralelo), e todos os 222 arquivos rodaram (1317 pass, 10 skip, quarentena vazia).
  `fast`: 154,7 s antes e 112,7 s depois, ambos com carga 3-6. Mais tarde, com carga 18-25 e dois `ci` de outros
  worktrees rodando, dois `fast` estouraram o teto: cada arquivo ficou 2,5-3× mais lento, sem falha de teste.
  Os tempos de lane são do runner (lane paralela N=8, sob carga). "Sozinho" é `node --test` do arquivo isolado.

  | Alvo | Antes | Depois | Observação |
  | --- | --- | --- | --- |
  | 1 `normal-oauth` | 100,9 s na lane; 55 s sozinho (auditoria) | 70-87 s na lane; 31 s sozinho (carga 3,5) | `held-ack` 6,2 → 1,1 s (ACK injetável `secretAckTimeoutMs` ≤ 5000; padrão 5000 provado com relógio falso). `deadline` 30,7 → 8,7 s |
  | 2 release ×3 | 3 builds; 97-103 s cada na lane | 1 build por execução; 101-156 s cada na lane | CPU: −2 builds completos. A lane não encurta: os três esperam o mesmo build e rodam juntos, e a carga foi maior. Os três juntos, sozinhos: 43 s de relógio |
  | 3 `architecture-gate` | 55,8 s na lane; 19 s sozinho | 7-9 s na lane; 2,2 s sozinho | APIs do dependency-cruiser e do ESLint em processo |
  | 4 forks de adapter | — | não aplicado | Muda o isolamento: está na proposta (P1-P3) |
  | 5 crash/SIGKILL | 5 arquivos com SIGKILL real em `fast` | os 5 em `slow` | A consolidação de cenários está na proposta (P4, P5) |

  Quarentena zerada: `admission-cli`, `normal-worker`, `public-copy-read` e `publication-composition` foram corrigidos
  e passaram nos três `ci`. O `bash-credential` voltou para a lane paralela. Os timers fixos que estouraram sob carga
  18 durante esta onda também viraram guarda de orçamento: `worker-process` (30 s), `public-bash-copy` (15 s),
  `normal-edit` (15 s) e os launchers de release (30/60 s).
  O guarda (`test/runner/budget.ts`) usa o fim do orçamento da camada (`FACTORY_TEST_DEADLINE`, passado pelo runner),
  mata a árvore do processo e nomeia a etapa em que parou.
  Não reproduzidos: `workers/host-launch-plan` e `records/incremental-retention` passaram em 50 execuções sob 6 hogs
  de CPU. São puros/síncronos, sem timer nem estado compartilhado, e não há log da falha. Não foram alterados.
  Ainda há ~100 `timeout:` fixos em outros testes de `fast`/`ci` (por exemplo `controller-ownership` 17,
  `protocol` 8, `upgrade` 8). Ficam fora deste escopo; candidatos a um ticket de varredura.
  O ticket fica aberto até o operador aprovar ou recusar a proposta acima. Sem a proposta, os critérios de medição,
  produto e três `ci` verdes já estão cumpridos.

- 2026-11-15 (ticket 37 implementer): **proposta aprovada pelo operador (P1–P5), estado final aplicado.**
  A tabela acima é a proposta. O estado final de cada item:

  | # | Estado | Teste(s) no fim | AC/achado coberto, e por qual teste |
  | --- | --- | --- | --- |
  | P1 | aplicado | `normal-oauth`: os 11 modos de resposta do provider são 11 `test()` sobre **um** boot compartilhado (uma ativação, worker Node24 nova, por modo; o audit é segmentado por `mode-begin/mode-end`). Os 7 modos que travam/revogam/abortam têm cadeia própria. Teste novo: o boot compartilhado fecha uma vez, depois de um spawn por ativação | As mesmas asserções por modo, no próprio teste do modo |
  | P2 | aplicado | `normal-edit`: `complete`, `mismatch`, `no-match`, `empty`, `budget` sobre um boot compartilhado; `invalid`, `uncertain`, `persist`, `cancel`, `eof`, `secret` isolados | As mesmas asserções por modo. O fixture acha a sessão pela receipt da própria ativação |
  | P3 | aplicado | `normal-edit`: um teste "Edit disabled (absent, standards, spec)", com três ativações num boot | As mesmas asserções por ativação, dentro do teste fundido. Mais `workers/native-builder-edit` (role/preflight) |
  | P4 | **não aplicado** | `control/recovery-crash` continua com os 8 SIGKILL reais | Tentei montar o estado do corte em processo: o Control real foi levado ao corte num diretório privado, e o SQLite + WAL e o `host.json` foram copiados. O dono reaberto **no mesmo processo** não reconciliou os cortes `receipt` e `question` como o filho morto (sem `recovery[0]`, sem `end`). O de `reservation` passou, mas com o mesmo risco de estado global do processo. Montar os registros à mão dependeria de detalhes internos do Pi Durable. Para não trocar cobertura por ~3 s, os cortes ficam reais. Nenhuma cobertura foi removida |
  | P5 | aplicado | `entrypoints/upgrade`: o corte `migrated` (e o resume com SIGKILL) continua sendo morte real. `journal` e `selected` param a mesma chamada de `upgrade` no passo, com um `observe` que nunca retorna | As mesmas asserções por corte (`UPGRADE_INCOMPLETE`, launcher recusado, rollback/resume, migração única) |

  Antes/depois por alvo, na lane `ci` (N=8, sob carga):
  - `normal-oauth`: 100,9 s na linha de base, 70-87 s com as otimizações de espera, 61-68 s com P1.
  - `normal-edit`: 79-98 s, 57-62 s com P2/P3. Sozinho: 57 → 27 s, com carga 6-7.
  - `upgrade`: 19-26 → 17-19 s.
  O desvio de P4 e o resto estão no `## Answer`.

- 2026-11-15 (ticket 37 implementer): **texto proposto para um ticket de acompanhamento (não criado):**

  > **NN: Guardas de orçamento no lugar dos timers fixos restantes de `fast`/`ci`**
  >
  > **What to build:** Trocar os ~110 `timeout:` fixos restantes em testes de `fast`/`ci` (`test()`, `spawnSync`, `fork`).
  > Os maiores são `controller-ownership` 17, `protocol` 8, `upgrade` 7, `review-session` 7 e `sandbox-adapter-diagnostics` 5,
  > e o resto está quase todo em `workers/*-process` e `native-*`. Trocar também os ~25 laços de espera com contagem fixa
  > (`for (let i = 0; i < 400/600/800/1500/2000 …)` em `control/*-flow`, `upgrade-fixture`, `*-cli`, `github-readiness-composed`,
  > `review28-*`, `recovery-crash`). O substituto é o guarda do ticket 37 (`test/runner/budget.ts`): `ended()` para filhos (spawn
  > destacado, evento de fim, árvore morta, etapa nomeada), `until()` para condições sem evento e `remainingMs()` onde um
  > `spawnSync` continuar.
  >
  > **Por quê:** é a mesma classe de flake que o ticket 37 corrigiu. Sob carga 15-20 de outras sessões, já estouraram nesta
  > onda `worker-process` (30 s), `public-bash-copy` (15 s), `normal-edit` (15 s), `github-checks-composed` (800 × 10 ms) e
  > `publication-composition` (600 × 10 ms).
  >
  > **Acceptance criteria:** nenhum `timeout:` numérico nem laço de espera com contagem fixa em `test/**` fora das receitas
  > `*-qualification`, garantido por um teste estático. O guarda fica em `test/runner/budget.ts`. `npm run test:ci` verde três
  > vezes seguidas com carga ≥ 12.
  >
  > **Blocked by:** 37.

## Answer

Resolvido em 2026-11-15.

**Runner.** Ele passa a cada arquivo o fim do orçamento da camada (`FACTORY_TEST_DEADLINE`) e um diretório privado da
execução (`FACTORY_TEST_RUN_DIRECTORY`). `test/runner/budget.ts` deriva dele os guardas, sem timeout fixo: `ended()`
espera o fim de um filho destacado e, ao estourar, mata a árvore e nomeia a etapa; `until()` espera condições sem evento,
limitado pelo orçamento.

**Quarentena zerada.** `admission-cli`, `normal-worker`, `public-copy-read` e `publication-composition` voltaram. O
`bash-credential` agora espera por evento e voltou para a lane paralela. O runner test #11 foi corrigido. Os timers fixos
que estouraram sob carga nesta onda também viraram guarda: `worker-process`, `public-bash-copy`, `normal-edit`, os
launchers de release e `github-checks-composed`. Quando o build ou a extração falham (por exemplo, com a cota de `/tmp`
esgotada, EDQUOT), o fixture de release passa a apagar o próprio diretório de trabalho.

**Alvos.**
1. ACK injetável (`secretAckTimeoutMs` ≤ 5000; produção não define, e o padrão de 5000 ms é provado com relógio falso).
   `held-ack` levava 6,2 s e agora leva 1,1 s; `deadline` caiu de 30 para 8 s.
2. Um build de release por execução, compartilhado pelos três arquivos de release (−2 builds de CPU).
3. `architecture-gate` usa as APIs em processo: 19 → 2,2 s sozinho, 56 → 7-10 s na lane.
4. P1–P3 aplicados.
5. Os 5 arquivos com SIGKILL real saíram de `fast`, e P5 foi aplicado. P4 não foi aplicado (ver Comments).

**Gate final.** Três `npm run test:ci` seguidos em HEAD (P1–P3, P5 e as correções desta rodada), todos verdes com
1327 testes (1317 pass, 10 skip, 0 fail) e quarentena vazia:

| Execução | Total (teto 600 s) | Lane paralela | Carga inicial |
| --- | --- | --- | --- |
| 1 | 187,9 s | 168,9 s | 15,0 |
| 2 | 222,6 s | 202,5 s | 13,5 |
| 3 | 236,3 s | 211,4 s | 14,7 |

Antes, em 9ca7bfa: 209,3 s com carga 8,7, mas com 4 arquivos em quarentena (não rodavam). e `fast` = 112,7 s com carga 3-6 (antes 154,7 s). Ainda
abaixo de 6 min, então a auditoria geral de redundância não volta. Fica pendente o ticket de acompanhamento proposto acima.

