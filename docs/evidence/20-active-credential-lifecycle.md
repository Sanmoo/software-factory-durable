# 20 — Renovar e retirar credenciais durante a atividade autorizada: incremento local

Autoridade: [ticket 20](../../.scratch/software-factory-mvp/issues/20-active-credential-lifecycle.md),
[spec §§8, 8.1, 12.2 e adendo HTTPS App](../../.scratch/software-factory/spec.md), [interfaces Q6/Q10](../../.scratch/software-factory/module-public-interfaces.md),
cenários V-03/V-13 da [matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).
Base: integração `6be3eda` (tickets 01–09). Branch `implement/software-factory-mvp-20`.

**Estado: implementação e suíte local verdes (níveis S/I-local); ensaio real NÃO executado por este agente** (sem GitHub/VM/credenciais/rede).
A receita fixa está em [§ Ensaio real](#ensaio-real-receita-one-shot). Nenhum checkbox marcado; ticket não resolvido. Dublê não comprova fronteira substituída.

## Composição implementada

- **GitHub (`platform/github`)**: `GitHubAccess.revoke(token)` faz **uma** auto-revogação `gh api --method DELETE /installation/token`
  autenticada pelo próprio token de instalação (nunca o JWT da App; adendo: só issuance usa HTTPS nativo), em diretório de config isolado,
  token só em `GH_TOKEN`. Resultados distintos (`RevocationResult` em `contracts`): `revoked` (204), `already-invalid` (401: expirado ou
  revogado antes — **não** prova cessação), `failed` (4xx completo), `unknown` (5xx/429/transporte: nunca repetido), `impossible`
  (valor ausente: nenhuma requisição). `createBuilderCredentials.revoke` usa isso; renovação continua sendo **nova `issue`**, sem método `renew`.
- **Sandbox (owner)**: um *holder* em memória por canal host-boot. Antes do launch: entrega inicial (inalterada). Depois do launch, **a mesma
  invocação Builder** aceita `deliver-credential` (renovação; registrada no Records **antes** do ACK) e `withdraw-credential` (final: nenhuma
  entrega posterior). Revisores, outra invocação, canal revogado: `CREDENTIAL_DELIVERY_DENIED`. O Bash Builder lê `current()` **de forma
  síncrona no início de cada comando**: comando novo recebe a concessão vigente; comando em curso e seus subprocessos conservam o ambiente
  com que começaram (o token já foi para o stdin do prelúdio).
- **Workers**: `deliver(worker, directive)` (Q6) com `{ kind: 'credential' }` ou `{ kind: 'withdraw-credential' }` para a ativação viva desta
  fachada; uma caixa de correio por canal roteia respostas por `reply_to`, então a resposta de credencial não consome os frames
  `worker-started`/`worker-completed`. Revisor → `CREDENTIAL_ROLE_DENIED`; desconhecido/fechado → `WORKER_NOT_CURRENT`, sem enviar nada.
- **Controle (`control/durable`)**: ciclo de vida por Execução, em memória da tarefa de execução existente (sem scheduler/broker/DI):
  1. Concessão inicial como no 09 (intenção durável antes do `issue`); lifecycle `active`.
  2. Enquanto aguarda o fim do Builder iniciado, a tarefa espera com **prazo** `expiresAt − beforeExpirySeconds` (porta
     `credentialRenewal`, padrão 600 s; independe da cadência/backoff do polling). No prazo: commit **`beginRenewal`** revalida Execução
     vigente `started` sem hold, Trabalho aberto, lifecycle ativo com renovação habilitada, repositório ainda configurado e mesma finalidade
     — **não** label/pausa/dependências (elegibilidade para próxima ativação). Registro durável da intenção → nova `issue` → metadados →
     confere lifecycle ainda ativo → `Workers.deliver` → `delivery: delivered`.
  3. Falha de emissão (`failed`/`unknown`) ou de entrega: registrada, **renovação parada** (`renewalStop`), concessão não entregue
     revogada; sem repetir POST, sem reiniciar/retomar/recuperar o Builder, sem hold automático. Concessão já vencida ao renovar → parada
     visível (`GRANT_LIFETIME_BELOW_RENEWAL_MARGIN`) em vez de laço.
  4. **Retirada** (primeira razão mantida): `ended`, `external-wait`, `cancelled`, `held`, `refused`, `owner-stopped`. Commit de retirada →
     aguarda renovação em voo (que então revoga sua própria concessão sem entregá-la) → `withdraw-credential` ao worker ainda vivo (espera
     externa/cancelamento/hold) → **uma** tentativa de revogação por concessão conhecida (inicial + renovações), resultado e código
     gravados por concessão. Revogação nunca altera `end.cessation`: o Slot só sai após cessação confirmada.
  5. **Boot** (`Control.run`): `reconcileLostCredentials` marca toda concessão sem resultado de revogação como `impossible`,
     `VALUE_LOST_AFTER_RESTART`, com `risk` (“pode continuar válida externamente, inclusive cópias, até `<expiresAt>`; expiração não prova
     cessação; isto sozinho não suspende a instalação”). Nada é recuperado de logs/sessões; nenhuma chamada de revogação; nenhum
     impedimento, pausa ou motivo de despacho é criado por isso.
  - Entrada de espera externa/cancelamento: `withdrawActivityCredentials(control, work_id, 'external-wait' | 'cancelled')`, seam interno do
    módulo (não faz parte do contrato público `Control`) para os fluxos dos tickets 10/25.
  - Estado durável (`ExecutionView`, só metadados): `credentialIssuance` e `credentialRenewals[]` com `{requestedAt, outcome, code, metadata,
    revocation, revocationCode, risk}` (+`sequence`, `delivery`), e `credentialLifecycle {state, withdrawnAt, reason, renewal, renewalStop}`.
    Registros antigos (09) são apresentados com padrões neutros.

## Mapa AC → evidência

Níveis: **S** Control real + Pi Durable/SQLite temporário + dublês de borda (GitHub tracker, relógio, Sandbox/Workers/credenciais);
**I-local** componentes reais com fronteira externa substituída (issuer App + gh self-revocation reais contra o mundo GitHub sintético;
Workers + Protocol reais; owner + Records + binding Bash reais com VM/spawn dublês). Segredos sempre sintéticos.

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Renovação = nova emissão pela projeção estreita após revalidar atividade/repo/finalidade; não serviço/cofre/ampliação/método paralelo | `control/credential-lifecycle` AC1/2/3 (cada renovação é `issue` com o mesmo contexto; nada de `renew`; label retirada não é lida), `entrypoints/credential-lifecycle` (POSTs reais reduzidos `builder-start` read, sem Workflows), `github-builder-credentials` | S + I-local | GitHub real (ensaio) |
| 2 Nova concessão em memória pelo caminho host antes de `expires_at`; comando novo recebe, subprocesso existente conserva | `credential-lifecycle` AC1/2/3 (primeira renovação antes do vencimento; Execução sobrevive à validade inicial várias vezes), `activate-credential` ticket 20 AC2 (`Workers.deliver` com frames intactos), `owner-credential` ticket 20 (renovação após launch registrada antes do ACK; próximo comando usa a nova), `bash-credential` ticket 20 AC2 (comando em curso manteve o valor antigo; seguinte recebeu o novo), `entrypoints/credential-lifecycle` (entregas pelo canal host na ordem de emissão, 1 launch) | S + I-local | Guest Alpine/gh reais (ensaio) |
| 3 Retirada de elegibilidade não corta atividade; handoff não exige rotação por rodada; nunca segredo ao revisor | `credential-lifecycle` AC1/2/3 (label removida durante a atividade: renovações continuam, sem `readTicket`), owner stop (`owner-stopped` revoga), `owner-credential` ticket 20 AC3 (canal de revisor recusa até “renovação”), `activate-credential` ticket 20 AC3 (`deliver` a revisor/desconhecido não envia nada) | S + I-local | Handoff real não existe ainda (ticket 12): renovação é por prazo, nunca por rodada |
| 4 Espera externa/fim/cancelamento retiram entregas/renovações e tentam revogar; sucesso/falha/impossibilidade distintos | `credential-lifecycle` AC4 ×2 (`external-wait`, `cancelled`: `withdraw-credential` antes das revogações; `revoked`/`failed`/`unknown` gravados; nenhuma emissão/entrega depois; fim não revoga de novo), corrida renovação×retirada (não entregue, revogada), `github-builder-credentials` ticket 20 AC4 (DELETE real do mundo sintético: `revoked`, `already-invalid`, `failed`, `unknown`, `impossible`), `entrypoints/credential-lifecycle` (todas as concessões auto-revogadas; 401 depois) | S + I-local | Gatilhos reais de espera/cancelamento são dos tickets 10/25 (seam pronto) |
| 5 Expiração durante comando: descobrir efeito antes de repetir; sem replay/recovery só para renovar; expirado/revogado não prova cessação | `credential-lifecycle` AC5 (renovação `unknown` registrada, um único POST, sem re-ativação/hold; após vencer a concessão inicial nada é repetido; revogada mas `cessation: unconfirmed` mantém Slot), `bash-credential`/Bash existente (nenhum comando é repetido pela Factory) | S | Expiração real de 1 h durante comando não exercida |
| 6 Após crash, valor perdido pode seguir válido; metadados explicam sem recuperar segredo, sem falsa revogação, sem bloquear a instalação só por isso | `credential-lifecycle` AC6 (processo controlador real **SIGKILL** com concessão ativa; reabertura: `impossible`/`VALUE_LOST_AFTER_RESTART`, `risk` com `expiresAt`, nenhuma chamada de revogação, sem impedimento; com o Slot recuperado — seam do ticket 26 — despacho `open` e o próximo Ticket inicia) | S | Recuperação de Slot real é ticket 26 |
| 7 Segredos fora de retorno serializável/recibo/sessão/prompt/argv/remoto; integração comprova renovação em execução longa e filtragem sintética | `credential-lifecycle` (SQLite sem token), `entrypoints/credential-lifecycle` (SQLite/WAL sem valores; payload de launch sem token), `bash-credential` ticket 20 AC7 (valor renovado partido entre chunks e stdout/stderr filtrado antes de captura e progresso), `owner-credential` (eco do valor renovado filtrado) | S + I-local | Sessão nativa real com valor real só no ensaio (contagem por formato) |

Mutações (JS compilado, restauradas): (M2) esperar `completed` sem `renewWhile` → 5/7 falham; (M3) revogar só a concessão inicial → 3 falham;
(M4) sem `reconcileLostCredentials` → AC6 falha; (M5) entregar renovação apesar da retirada → corrida falha; (M6) sem `withdraw-credential`
ao worker → 2 falham; (M7) teste de chunks sem registrar o valor renovado → falha.

## TDD observado (honesto)

Vermelho primeiro: `github-builder-credentials` (tipo `code` ausente; depois falha real do fixture: DELETE com falha injetada ainda revogava),
`bash-credential`/`owner-credential` (tipo do holder), `activate-credential` (`deliver` inexistente; depois falha real do owner roteirizado),
`control/credential-lifecycle` (seams/tipos inexistentes). O controle passou verde na primeira compilação: a capacidade de detecção foi
comprovada pelas mutações acima. `entrypoints/credential-lifecycle` falhou primeiro por ordem do próprio teste (inspect após stop).

## Decisões de interpretação e questões abertas (operador)

1. **Gatilhos de espera externa e cancelamento.** Não existem neste incremento (tickets 10/25). O mecanismo e o seam interno
   `withdrawActivityCredentials`/`dispatcher.withdraw` estão prontos e testados; nenhuma operação pública nova foi acrescentada ao `Control`.
2. **Hold retira credenciais** — **aprovado pelo supervisor** (2026-11-14): uma Execução `held` não está autorizada a avançar; retirada
   `held` + revogação, inclusive se o commit do hold falhar.
3. **Política de falha de renovação.** Uma tentativa por prazo; qualquer falha (inclusive rejeição conhecida, p.ex. rate limit) para as
   renovações daquela atividade, que segue até a concessão vigente expirar (gh/git no guest passam a falhar), sem reinício. Retentativa
   limitada para rejeições conhecidas seria decisão nova.
4. **Concessões anteriores continuam válidas até o fim.** Como subprocessos existentes conservam o valor antigo, a renovação não revoga a
   anterior; todas as conhecidas são revogadas na retirada. Janela: até N tokens vivos por ≤ 1 h cada.
5. **Margem e espera.** `credentialRenewal.beforeExpirySeconds` (padrão 600) é parâmetro de composição; a configuração declarativa ainda não o
   expõe (a composição de produção ainda não tem portas de execução — ticket 32). A espera é prazo dentro da tarefa da Execução, não do polling.
6. **Credencial de fetch do cache** (`repository-fetch`, host) — **decidido pelo supervisor**: auto-revogada logo após o fetch (também em
   falha do fetch/lock), uma vez; `checkout.json` guarda só o tipo do resultado (`fetchCredentialRevocation`).
7. **Integração I-local unida no frame do Protocol.** A regra `public-entry` impede `test/entrypoints` de importar o owner; o lado owner dos
   mesmos frames é coberto com código real em `test/sandbox/owner-credential`.
8. **`Workers.deliver`** só conhece diretivas de credencial; a entrega de resultados de revisão (tickets 12/13) estenderá a união.
9. **Impressão digital no ensaio** — **aprovada pelo supervisor**: a receita registra apenas `sha256(token)[0:12]`.

## Ensaio real (receita one-shot)

Receita: `dist/test/entrypoints/credential20-qualification.js` (fonte `test/entrypoints/credential20-qualification.ts`, provedor roteirizado
`credential20-provider.ts`). `--plan` é inerte e imprime os limites. Fases one-shot com tombstone `*-intent.json` exclusivo em
`$HOME/software-factory-test/y5/q20-credentials-v1/` (criado na `preflight`; existir = consumido). Sem retry; falha grava `*-held.json`.

**O modelo é substituído** por um provedor local roteirizado (`127.0.0.1:18720`, SSE openai-completions, mesmo padrão do ensaio finito do 05):
o worker Builder real, a VM real e o gh/git reais do guest executam uma agenda fixa de 5 comandos Bash; nenhuma requisição de modelo/OAuth.
O que o ensaio comprova: tokens reais da App emitidos, entregues e **renovados durante a atividade real**, comando em curso conservando o
valor, comando novo recebendo o renovado, leituras GitHub reais com cada um, auto-revogação real e GitHub recusando depois. Não comprova
comportamento de modelo real.

Pré-requisitos (operador/supervisor), como no 09: raiz `y5` privada (0700) com `credentials/` e `run/`; cópia exclusiva 0600 da chave da App em
`y5/credentials/app.pem` (remover ao fim); `gh`, `git`, `flock`, `qemu-img`, `systemd --user`, KVM; assets `assets34` (pin `8efa506a…`);
SDKs de desenvolvimento preparados; porta `127.0.0.1:18720` livre. A issue **#3** de `Sanmoo/java-springboot-event-sourcing` deve ser a
**única** aberta com `ready-for-agent` (a `preflight` exige; retirar temporariamente de outras e restaurar depois). Build: `tsc` neste HEAD.

```sh
NODE="env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node"
$NODE dist/test/entrypoints/credential20-qualification.js --plan
$NODE dist/test/entrypoints/credential20-qualification.js preflight   # GitHub somente leitura
$NODE dist/test/entrypoints/credential20-qualification.js run         # efeito real: 1 VM, 1 Builder roteirizado, ~5 min (prazo 15 min)
$NODE dist/test/entrypoints/credential20-qualification.js inspect     # somente leitura
# se run terminar com o boot próprio possivelmente ativo (reserved/started/held, ou ended sem cessação confirmada):
$NODE dist/test/entrypoints/credential20-qualification.js stop-environment
```

Efeitos e limites:

- **GitHub**: só a App da Factory e o repositório configurado. Controlador: tokens de leitura por finalidade + `repository-fetch` (Contents R).
  Builder: `builder-start {metadata, contents, issues: read}` inicial + renovações (`beforeExpirySeconds: 3510` ⇒ uma a cada ~90 s; **no
  máximo 8 emissões**, guarda da receita). Escritas: apenas `POST …/access_tokens` e `DELETE /installation/token` (uma por concessão no fim +
  uma de verificação por concessão, esperando 401). Push/PR/issues/labels impossíveis com essas permissões.
- **VM**: 1 ambiente novo (disco 40 GiB qcow2 de assets34 + checkout; sem skill pack), 1 boot (4096 MiB, 2 vCPU), parada pública ao fim; sem
  `remove`/cleanup. Cache em `y5/cache/git/1256893534.git` (fetch).
- **Agenda Bash no guest** (cada uma recebe `GH_TOKEN`/helper pelo prelúdio): c0 impressão digital + `gh api repos/…` + `git ls-remote`; c1
  impressão, `sleep 150`, impressão, `gh api` (atravessa a 1ª renovação); c2 impressão + `gh api`; c3 `sleep 60` + impressão + `gh api`
  (atravessa a 2ª); c4 impressão + `gh api`. Depois `Complete.` ⇒ fim ⇒ retirada ⇒ revogação.
- **Prazo da receita**: 15 min; ao fim o Control é parado (parada também retira e revoga) e o estado salvo em `run-result.json`.

Observações esperadas:

1. `run-result.json` → `verdict.passed: true`, com `initialGrantFirst`, `runningCommandKeptItsValue` (c1a = c1b = concessão 1),
   `renewalDeliveredWhileC1Ran`, `newCommandGotRenewal` (c2 = renovação entregue), `latestDeliveredReachedLastCommand`, `everyReadWorked`
   (5 leituras), `atLeastTwoRenewalsDelivered`, `everyGrantRevoked`, `githubRejectsEveryGrantAfterwards` (pós-verificação `already-invalid`).
2. `final.works[#3].execution`: `state: ended`, `dispatch.phase: stopped`, `slot.held: false`, `end.cessation: confirmed`;
   `credentialRenewals` ≥ 2 com `outcome: issued`, `delivery: delivered`, `revocation: revoked`; `credentialIssuance.revocation: revoked`;
   `credentialLifecycle {state: withdrawn, reason: ended, renewal: enabled}`; metadados sempre `builder-start` read.
3. `events`: 1 `prepare`, 1 `start`, 1 `activate` (`credentialDelivered: true`), `issued`/`deliver` alternados a cada ~90 s, `revoke` por
   concessão com `GITHUB_TOKEN_REVOKED`, 1 `stop`.
4. `inspect-result.json` → `secretShapes`: 0 em observações, `control.sqlite*`, evidências do Trabalho e diretório de runtime do boot (sessão).
5. Desvios que exigem disposição do operador: `verdict.passed: false` (ver `checks`), `held`, prazo atingido, `provider.held: true`,
   pós-verificação diferente de `already-invalid` (a concessão pode seguir válida até `expiresAt`).

## Correções da revisão estática independente (2026-11-14, sobre `54aac1e`)

Todas com teste vermelho antes da correção ou mutação que comprova a detecção (JS compilado, restaurado).

| # | Achado | Correção | Teste (vermelho / mutação) |
| --- | --- | --- | --- |
| 1 (médio) | Retirada entre registro do lifecycle e `attach`: Builder ativado com token retirado; `withdraw` respondia `not-active` durante a emissão inicial | Lifecycle registrado **antes** da emissão (emissão em voo visível); `withdrawn` conferido após a emissão e imediatamente antes do `activate` → para o boot próprio e `held` `ACTIVATION_CREDENTIALS_WITHDRAWN`, sem ativar; `attach` após retirada envia `withdraw-credential` na hora | `credential-lifecycle` review 1 e review 1/6 (vermelhos; mutações M1/M1b detectadas) |
| 2 (médio) | Renovação podia emitir após início da retirada/parada | Reconferência de `withdrawn`/`stopping` entre `beginRenewal` e `issue`; renovação gravada `not-attempted` / `CREDENTIALS_WITHDRAWN` | `review 2 (deterministic)` (retirada disparada exatamente após o commit da intenção; mutação M2 detectada). A varredura temporal `review 2` não ficou vermelha antes da correção (janela estreita): mantida só como regressão |
| 3 (médio) | `hold()` pulava a retirada se `holdExecution` lançasse | Retirada em `finally` | `credential-hold` (commit de hold forçado a falhar por `mock.module`; vermelho; mutação M3 detectada) |
| 4 (baixo) | Reconciliação rotulava como valor perdido uma revogação tentada cujo registro falhou; reexecução in-process; `inspect` da receita escrevia | Intenção durável `revocationAttemptedAt` antes de cada DELETE → no boot `unknown` / `REVOCATION_OUTCOME_LOST_AFTER_RESTART` com risco; concessões vivas neste processo (`isLiveCredentialExecution`) nunca reetiquetadas; `run` com sinal já abortado não reconcilia (inspeção somente leitura) | review 4 (SIGKILL durante a revogação; vermelho; mutação M4 detectada) |
| 5 (baixo) | Registros anteriores ao 20 apareciam com lifecycle `active` | Estado derivado da Execução (`ended/released/held` → `withdrawn` / `legacy-unknown`); `not-attempted` antigo recebe texto de risco na reconciliação | review 5 (vermelho) |
| 6 (baixo) | Resultado do `withdraw-credential` não era durável | `credentialLifecycle.workerNotice` (`withdrawn` ou código) | AC4 external-wait/cancelled + review 1/6 (vermelhos; mutação M6 detectada) |
| 7 (baixo) | `expiresAt` inválido podia gerar laço | Renovação parada com `GRANT_EXPIRY_INVALID` | review 7 (vermelho; mutação M7 detectada) |
| 8 (baixo) | Caixa de correio bufferizava frames inesperados; owner sem resposta para valor vazio | Só respostas a pedidos enviados são aceitas; qualquer outro frame torna o canal incerto (`WORKER_EXECUTION_UNCERTAIN`); owner responde `CREDENTIAL_DELIVERY_DENIED` | `activate-credential` review 8 (vermelho: travava), `owner-credential` review 8 |
| decisão | Credencial de fetch do host | Auto-revogação após o fetch | `sandbox-checkout` (vermelho), `github-builder-credentials` (DELETE real do mundo sintético) |

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60`, sem npm/npx, após `rm -rf dist`
(HEAD `daf7216` + este documento): `dependency-cruiser` sem violações (248 módulos, 1391 dependências); `eslint . --max-warnings 0` exit 0;
`tsc -p tsconfig.json` exit 0; **106 arquivos** `dist/test/**/*.test.js`, um por vez (`--experimental-test-module-mocks --test
--test-concurrency=1`): **798 pass, 0 fail, 10 skipped, 1 cancelled**. O cancelado é `entrypoints/normal-oauth` (arquivo não alterado aqui)
atingindo o limite de 60 s por arquivo: isolado com limite de 150 s passa **18/18 em 64 s** (o caso `deadline` sozinho leva 30,8 s), sob carga
de outros gates em paralelo no host. A comparação com a base `6be3eda` numa cópia temporária não foi possível (fixtures dependentes de
caminho falham fora da worktree). Registrado como estouro de tempo a observar, sem regressão demonstrada. Os 10 skips são os mesmos de antes
(host-dependentes); `test/sandbox/gondolin.test.ts` continua `skip:true`.

Novos/ampliados: `control/credential-lifecycle` (7, inclui crash por SIGKILL de processo filho `credential-crash-child`),
`entrypoints/credential-lifecycle` (1, I-local), `entrypoints/credential20-qualification` (5, receita inerte/agenda/provedor/veredito),
`github-builder-credentials` (+1), `bash-credential` (+2), `owner-credential` (+2), `activate-credential` (+2); ajustados `execution-flow`
(dublê com `deliver`, campos novos do registro) e `builder09-qualification` (composição com `deliver`).

**Gate após as correções da revisão** (HEAD `9d7c270` + este documento, `rm -rf dist`): `dependency-cruiser` sem violações (249 módulos,
1400 dependências); eslint exit 0; tsc exit 0; **107 arquivos**, um por vez com `timeout 60`: 809 pass, 0 fail, 10 skipped, 1 cancelled —
o cancelado é de novo `entrypoints/normal-oauth` (16 passes contados antes do corte). Por decisão do supervisor, **somente esse arquivo** usa
limite documentado de **90 s** (teste inalterado): `timeout 90` → **18/18 pass em 55 s**. Total efetivo: **811 pass, 0 fail, 10 skipped,
0 cancelled**. Novos nesta rodada: `control/credential-hold` (1), `credential-lifecycle` +7 (review 1, 1/6, 2 varredura, 2 determinístico,
4, 5, 7), `activate-credential` +1, `owner-credential` +1, `sandbox-checkout` +1; ampliados `github-builder-credentials` e os testes AC4.


## Ensaio real autorizado — 2026-11-14 (supervisor)

HEAD `0a346aa`, namespace `y5/q20-credentials-v1`. Pré-condições como no 09: a #3 é a única com `ready-for-agent` (label da #1 removida temporariamente) e há cópia exclusiva da chave. Registros: [run](20-real-credential-run-2026-11-14.json), [inspect](20-real-credential-inspect-2026-11-14.json).

- 1 VM (assets34), um Builder real conduzido pelo provedor local roteirizado (sem modelo), 18:04–18:08 UTC.
- 3 emissões reais `builder-start` (só leitura) e **2 renovações entregues** durante a atividade. O comando em execução manteve o valor antigo e o seguinte recebeu o renovado; o último comando recebeu o último grant entregue; as 5 leituras reais (`gh api`, `git ls-remote`) funcionaram.
- Fim: lifecycle `withdrawn / ended` e **3 auto-revogações** `DELETE /installation/token`. Na pós-checagem, o GitHub rejeita os 3 tokens (`already-invalid`). Execution `ended`, Slot liberado após cessação confirmada.
- `verdict.passed: true` (9/9 checks).
- Varredura de segredos: 0 em storage, observações e Records. As 6 ocorrências no runtime do boot (`r/<boot>/mitm-ca/*.key`) são as chaves privadas da CA de mediação TLS por boot, que o desenho do 06 mantém de propósito no diretório 0700 do boot. Não são tokens. Nenhum `ghs_` em parte alguma.
