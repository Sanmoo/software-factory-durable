# 26 — Recuperar Execuções sem adotar sobreviventes: incremento local

Autoridade: [ticket 26](../../.scratch/software-factory-mvp/issues/26-execution-recovery-without-survivor-adoption.md),
[spec §§3.4, 4.4, 5.2, 5.3, 5.4, 5.7, 11.4](../../.scratch/software-factory/spec.md), [interfaces Q3/Q5/Q6/Q8/Q11](../../.scratch/software-factory/module-public-interfaces.md),
cenários V-01/V-07/V-12/V-13 da [matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).
Base: integração `314f241` (tickets 01–13, 19, 20, 32 + 11). Branch `implement/software-factory-mvp-26`.

**Estado: implementação e suíte local verdes (níveis R/S/I-local, com cortes SIGKILL reais de processo controlador); ensaio real NÃO executado
por este agente** (sem GitHub/VM/systemd/credenciais/rede/modelo). A receita fixa está em [§ Ensaio real](#ensaio-real-receita-one-shot).
Nenhum checkbox marcado; ticket não resolvido. Dublê não comprova fronteira substituída.

## Composição implementada

- **Inventário do host no boot** (`src/sandbox/inventory.ts`, `inventoryRuntime(root)`, exportado pelo Sandbox para a composição; nunca ferramenta
  de worker): após o lock e antes do storage, leitura no-follow/limitada de `environments/` (atribuição pelo `owner.json` próprio, só aceita se
  `env = sha256(workId)`), dos estados `cache/git/<repositoryId>.state.json` (cache em preparo ⇒ `preparing`) e de toda outra entrada de `run/`
  (desconhecida). O proprietário (`entrypoints/controller/owner.ts`) passa `runtimeInventory: {kind:'listed', …}` ao Control
  (os modos `empty`/`unknown` continuam aceitos para composições legadas/inspeção).
- **Sandbox.observe sem boot** (aprovado Q5: "funciona para inventário/parada mesmo sem o proprietário Gondolin antigo vivo"): observa o boot
  publicado em `current.json` e o devolve (`boot`) para a parada; ambiente próprio preparado sem `current.json` ⇒ `not-booted` (o `current.json` é
  renomeado e sincronizado **antes** de qualquer `systemd-run`, logo nenhuma unit pode existir).
- **Recibo sem notificação** (Q6 `observe`, faceta de recibos — `Workers.observeStart`; Q8 `read(selection)` com filtros — `Records.find`): lista
  as capturas da Execução/invocação (`callId: worker-start`); exatamente uma completa, íntegra e correlacionada ⇒ início; listagem completa vazia ⇒
  ausência; parcial/corrompida/múltipla/ilegível ⇒ incerteza (nunca ausência).
- **Regras puras** (`src/control/rules/recovery.ts`): esperas 5/15/45 s pelos recoveries já consumidos (espera maior do serviço prevalece; pedido
  repetido mantém o prazo); classificação de interrupção (transitória de worker/transporte/canal ⇒ recuperável; autorização/config/drift/
  integridade/preparo/cancelamento ⇒ bloqueia); decisão de início (recibo notificado ou descoberto ⇒ iniciado; fases anteriores a
  `activation-requested` ⇒ não início; ausência só com cessação confirmada; resto incerto); portão global; instrução substituta explícita.
- **Reconciliação de boot** (`src/control/durable/recovery.ts`, chamada em `run()` com a barreira fechada, após `reconcileLostCredentials` e
  `reconcileDurations`, nunca numa inspeção abortada): para cada Execução não assentada (Slot retido, reservada/iniciada/retida, ou encerrada sem
  cessação confirmada) que não pertence a este processo:
  1. **Cessação pelo host** (`ceaseOwn`): fase `reserved` ⇒ nada foi bootado; boot registrado ⇒ `Sandbox.stop` (systemd/cgroup; funciona sem o
     dono antigo); sem boot registrado ⇒ `Sandbox.observe` do boot atual e parada dele se ativo. Nunca PID, abort, canal fechado ou token.
  2. **Início**: só depois da cessação confirmada consulta o recibo (`observeStart`).
  3. **Um commit** (`settleInterruption`, fronteira "Confirmar efeito/cessação"): registra `execution.recovery[]` (evidência antiga encontrada,
     `controllerRunId` desta abertura, cessação, início, decisão); recibo descoberto ⇒ `start` + **consumo único** + duração `lower-bound`
     (ultrapassagem não excluível com timeout); não início ⇒ reserva liberada sem consumo, `released`, mesma posição; início incerto ⇒ reserva
     **mantida**, `RECOVERY_START_UNCERTAIN`; cessação não confirmada ⇒ Slot/reserva mantidos, `RECOVERY_CESSATION_UNCONFIRMED` (incerteza
     **local**). Iniciada: Pergunta registrada por ela ⇒ fim `question` (espera a resposta); senão fim `failure` com o código do hold ou
     `CONTROLLER_CRASH` e, se recuperável, **um** recovery operacional pendente com espera persistida; bloqueante ⇒ `RECOVERY_BLOCKED`.
  4. Varredura dos ambientes listados de Trabalhos já assentados: boot ativo sem Execução ⇒ parado (não adotado); não confirmável ⇒ global.
  5. **Portão** (`dispatchGate`): recursos desconhecidos/não atribuídos, tarefas persistidas, Slot sem Execução vigente, inventário `unknown` ou
     atividade não contabilizada ⇒ `RECONCILIATION_REQUIRED` (global). Senão aberto; Trabalhos com incerteza local seguem retidos e ocupando
     capacidade; cache em preparo bloqueia só o repositório (`CACHE_RECONCILIATION_REQUIRED`, fato do boot).
- **Recovery operacional vivo** (AC6): `releaseAfterCessation` de um fim `failure` recuperável pede o recovery no **mesmo commit** da cessação
  (nunca perdido por crash). `requestOperationalRecovery` (seam do 19) usa a mesma regra. A espera é verificada no `tick`, na apresentação e no
  commit de admissão (`RECOVERY_BACKOFF`, relógio de calendário injetável `ExecutionPorts.calendar`, nunca o monotônico); polling, eventos e
  restarts não a antecipam; esgotamento ⇒ `RECOVERY_LIMIT_REACHED` imediato.
- **Retomada** (compõe com 11): `interruptionBasis` (fim `stopped` ⇒ `ADMINISTRATIVE_STOP`; fim `failure` com recovery pendente ⇒
  `OPERATIONAL_RECOVERY`; Execução liberada antes do início herda a base) é revalidada no commit de admissão (`INTERRUPTION_BASIS_CHANGED`) e
  gravada em `execution.interruption`. O `activationPlan` exige o contexto preservado do 11 (`recoveryContext`: mesmo base/branch/checkout e
  `checkout.reused`) e envia `interruptionRecoveryPrompt` (nova sessão, mesmo workspace, inspecionar antes de repetir, nunca repetir ferramenta às
  cegas), `phaseId: builder-recovery`; nunca `/implement` de novo.
- **Parada administrativa** (AC7): `run()` devolve `clean` só se toda atividade própria teve cessação confirmada e fim persistido; senão
  `uncertain` (contrato Q3 "parada limpa, falha ou parada incerta"). Builder iniciado ⇒ `Sandbox.stop` próprio, fim `stopped`
  (`ADMINISTRATIVE_STOP`, duração medida) e Slot liberado; antes do recibo confirmado ⇒ mesma reconciliação (`trigger: administrative-stop`);
  cessação não confirmada ⇒ hold `ADMINISTRATIVE_STOP_CESSATION_UNCONFIRMED`, tratado no boot seguinte como interrupção (falha, recovery cobrado).
  Continuação após parada limpa: nova Execução pela fila, `charge: none` (sem cobrança de recovery só pela parada). Parada antes de qualquer
  `Sandbox.start` agora é não início comprovado (Slot liberado).
- **Holds "operator recovery (ticket 26)"** dos tickets anteriores: deixam de reter o Slot para sempre — o próximo boot (reinício do controlador é a
  ação do operador) os reconcilia: cessação pelo host, início pelo recibo, e classificação (recuperável ⇒ recovery com espera; bloqueante ⇒
  `RECOVERY_BLOCKED`, decisão explícita).

## Mapa AC → evidência

Níveis: **R** regras puras; **S** Control real + Pi Durable/SQLite temporário + Records reais + faceta real `Workers.observeStart`, com dublês de
Sandbox host (arquivo), Builder, credenciais e GitHub; **S+K** idem com **processo controlador real morto por SIGKILL** no corte e novo Control no
mesmo storage; **I-local** componentes reais com fronteira externa substituída. **A** (real) só pelo ensaio.

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Boot exclusivo, barreira fechada, inventário (reservas, recibos, recursos, processos, cache, adapter morto) | `recovery-crash` "tool cut" (barreira `closed/RECONCILIATION_REQUIRED` ao abrir; primeiro efeito = parada do sobrevivente); `recovery-flow` "listed host inventory" (desconhecidos fecham; cache em preparo bloqueia só o repo; sobrevivente sem Execução parado); `sandbox-inventory` (atribuição, cache, desconhecidos, sem alteração; `not-booted`); `controller-ownership` (flock/unknown, existente) | S+K, S, I-local | Inventário real com VM/systemd/cache e adapter morto: ensaio (`a-tool`→`b`) |
| 2 Sobreviventes encerrados, não adotados; cessação comprovada pelo host antes do substituto | `recovery-crash` "tool cut" (stop do boot sobrevivente antes de qualquer prepare; substituto em boot NOVO), "spawn cut" (cessação antes da ativação substituta), "local uncertainty" (stop sem confirmação ⇒ nada substitui); cessação real do `Sandbox.stop`/`observe` coberta pelos testes de sandbox existentes (03/W3) | S+K | Unit/cgroup/VMM/worker reais: ensaio |
| 3 Recibo completo confirma início/consumo único sem notificação; ausência só prova não início com storage íntegro e cessação; senão mantém reserva | `recovery-crash` "receipt cut" (recibo descoberto, recovery consumido 1×), "spawn cut" (ausência após cessação ⇒ não início, nada consumido), "reservation cut"; `recovery-rules` startDecision; `observe-start`/`find` (parcial/múltiplo/corrompido ⇒ incerto) | S+K, R, I-local | Recibo real do worker host: ensaio (`c-spawn`→`d`) |
| 4 Evidência antiga incorporada explicitamente; mensagem antiga não altera reserva; replay não autoriza spawn | `recovery-crash` "tool cut" (`recovery[].controllerRunId` ≠ origem antiga; `confirmStart` tardio da Execução antiga ⇒ `stale`; reinício não recobra nem relança), "question cut" (Pergunta antiga liga o fim); `recovery-rules` portão com tarefas persistidas; `controller-ownership` `STALE_CONTROLLER` (existente) | S+K, R | Replay de tarefa Pi Durable: o Control não cria tarefas; só o portão (tarefas ⇒ fechado) é testado |
| 5 Incerteza local bloqueia só o afetado; global mantém despacho fechado; recursos desconhecidos não ignorados | `recovery-crash` "local uncertainty" (capacidade 2: um Trabalho retido com Slot, o outro recupera); `recovery-flow` inventário (global); `recovery-rules` portão | S+K, S, R | — |
| 6 Recuperáveis voltam à fila com contagem separada e espera 5/15/45 s (ou maior do serviço); repetição não antecipa nem renova | `recovery-flow` "live transient failure" (5/15/45, `already-open` mantém prazo, esgotamento, restart não zera), "blocking failure"; `recovery-rules` waits/request/backoff/classify; `budget-flow` (seam ajustado) | S, R | Espera maior indicada pelo serviço: regra pronta, mas nenhum adapter atual entrega `retry-after` ao Control |
| 7 Parada administrativa limpa só após cessação/persistência; continuação sem recovery; crash/forçada/incerta mantém falha e evidência temporal | `recovery-flow` "administrative stop is clean only…", "stop whose cessation is unconfirmed…", "while the start receipt is awaited…"; `execution-flow`/`budget-flow` (ajustados) | S | Parada real (SIGINT do proprietário com VM): ensaio `d-final` (saída 0) |
| 8 Provas reais com cortes reserva/spawn/recibo/ferramenta/cache/processos; sem escritor/consumo duplicado; contexto preservado; perda de saída ⇒ inspeção | Local: os 6 cortes SIGKILL (`recovery-crash`), checkout reutilizado + instrução substituta (`recovery-rules`, "tool cut"). Real: [receita](#ensaio-real-receita-one-shot) | S+K / A pendente | Corte de cache real não incluído na receita (deixaria o cache do root em `mutating` para reconciliação manual); ver decisões |

### Testes de tickets anteriores ajustados (expectativas "até o ticket 26")

- `credential-lifecycle` ticket 20 AC6: o Slot recuperado agora vem da reconciliação real (não da emulação pelo seam); despacho abre e o risco fica.
- `budget-flow` AC3: o recovery concedido só parte após a espera persistida (calendário de teste avançado). AC2 "owner stop": parada antes de
  qualquer `Sandbox.start` é não início comprovado (Slot liberado) — antes retinha o Slot por cautela sem base.
- `execution-flow` review 3: parada enquanto o recibo é aguardado, sem faceta de recibo composta ⇒ `uncertain`.

## Decisões abertas / lacunas de desenho (ao operador)

1. **`observeStart` como nome separado** de `ExecutionPorts.workers.observe` (11 usa `observe` para a sessão). Ambos são facetas da operação Q6
   `observe` aprovada; unificar a assinatura é refatoração posterior, não mudança de contrato.
2. **`Sandbox.observe` sem boot devolve `boot` e a condição `not-booted`** (extensão aditiva da observação aprovada). `inventoryRuntime` é uma
   função de composição do Sandbox (leitura do próprio layout), não operação nova do Control.
3. **Hold bloqueante ⇒ `RECOVERY_BLOCKED` sem comando de saída**: `resume <trabalho>` (spec §11.3) não existe ainda; até lá a decisão explícita
   do operador não tem ingresso. Recomendado atribuir ao ticket que implementar `resume`.
4. **Preparação interrompida** (fase `reserved`): considerada sem boot (correto) e o Slot é liberado; um `qemu-img`/`git` órfão do controlador
   morto não é processo do grupo supervisionado — o ambiente incompleto nunca é adotado (`ENVIRONMENT_PREPARATION_INCOMPLETE`) e o cache em
   preparo bloqueia o repositório. Supervisionar o preparo num grupo próprio seria mudança de desenho.
5. **Ambiente de Trabalho assentado com observação indeterminada** fecha o despacho globalmente (conservador).
6. **Espera de 5 s com polling de 60 s**: a espera é um piso persistido; o início ocorre no primeiro ciclo após o prazo.

## Ensaio real (receita one-shot)

Receita: `test/entrypoints/recovery26-qualification.ts` (+ provedor `recovery26-provider.ts`, segurança `recovery26-qualification.test.ts`).
Importar e `--plan` são inertes (testado). Cada fase é one-shot (tombstone exclusivo `<fase>-intent`, e por passo filho `<passo>-intent`), sem retry;
falha ⇒ `<fase>-held.json` e fim.

```sh
cd <worktree>; node node_modules/typescript/bin/tsc -p tsconfig.json
N="env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node"
$N dist/test/entrypoints/recovery26-qualification.js --plan        # inerte
$N dist/test/entrypoints/recovery26-qualification.js preflight     # leitura GitHub + inventário/observe do root; cria observations e o lock
$N dist/test/entrypoints/recovery26-qualification.js run           # 4 controladores filhos sob flock, cortes a/b/c, final d
$N dist/test/entrypoints/recovery26-qualification.js inspect       # cópia privada exclusiva do storage, Records find, varredura de segredos
$N dist/test/entrypoints/recovery26-qualification.js stop-environment   # só se a última Execução puder estar ativa
```

- **Escopo/limites**: root `/home/sanmoo/software-factory-test/y5`, observações `y5/q26-recovery-v1` (namespace novo); somente issue sintética #3
  de `Sanmoo/java-springboot-event-sourcing` (preflight exige a listagem com exatamente ela); concessões só leitura (`builder-start` e
  `repository-fetch`), ≤ 2 emissões por filho; prepare/activate ≤ 1 por filho e só para o Trabalho do #3; VMs 4096 MiB/2 vCPU/40 GiB; polling
  30 s; prazo 10 min por filho (≈ 25 min no total); provedor local 127.0.0.1:18726 (≤ 4 ativações/12 pedidos; nenhum modelo/OAuth); sem push/PR,
  remove ou cleanup; nenhum git do host em árvore gravável pelo guest; leituras do host no-follow e limitadas; `inspect` só numa cópia exclusiva.
- **Pré-existentes**: o preflight registra os ambientes já presentes no root (de qualificações anteriores), exige cada um cessado
  (`Sandbox.observe`) e nenhum `run/` desconhecido nem cache do repo em preparo; os filhos os excluem do inventário (decisão registrada).
- **Cortes** (o provedor vive no orquestrador e sobrevive a todos): `a-tool` SIGKILL ~10 s após o `sleep 600` chegar ao worker (VM + worker
  sobrevivem sob systemd); `b-reservation` reconcilia (para o sobrevivente) e se mata na entrada do preparo do recovery; `c-spawn` reconcilia
  (libera a reserva) e se mata logo após o pedido de ativação do recovery; `d-final` reconcilia (recibo descoberto ou ausência após cessação),
  conclui o recovery no checkout preservado e para limpo (saída 0).
- **Observações esperadas** (`inspect-result.json` → `verdict.checks`, todos `true`): `toolCutReconciled`, `survivorStoppedBeforeNewWork`,
  `reservationCutReleased`, `spawnCutSettled`, `noTwoWriters`, `recoveryCompletedOnPreservedContext`, `singleConsumption`, `cleanFinalStop`,
  `providerSchedule` (marcador `a1-c1-start` sem `a1-c1-end`; ativações ≥ 2 só com a instrução de recuperação); `secretShapes` zerados.
  Resultado inconclusivo (p. ex. o worker do corte c ainda não escreveu recibo) continua válido se `spawnCutSettled` for satisfeito pelo ramo de
  não início; qualquer `false` reprova.
- **Fora da receita**: corte real durante `git fetch` do cache (deixaria `cache/git/<id>.state.json` em `mutating`, exigindo reconciliação manual
  do operador para qualquer preparo futuro desse repo no root). Coberto localmente pelo inventário/portão; proposto como ensaio separado em root
  descartável.

## Gate local

Comandos Node exatamente `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 90 …/node/24.21.0/bin/node`, sem npm/npx.

- `tsc -p tsconfig.json`: OK. `eslint . --max-warnings 0`: OK. `dependency-cruiser`: 0 violações (332 módulos, 1974 dependências).
- Suíte compilada, **um arquivo por vez** (`--experimental-test-module-mocks --test --test-concurrency=1`): **153 arquivos, 996 pass, 0 fail,
  10 skip** (skips preexistentes, incl. `test/sandbox/gondolin.test.ts` `skip:true` intocado).
- TDD: os cortes SIGKILL (`recovery-crash`) rodaram vermelhos primeiro e revelaram que o registro `execution.recovery` não era persistido
  (array atribuído e mutado no lugar dentro do commit); corrigido para atribuição nova. Os testes dos tickets anteriores listados acima ficaram
  vermelhos com a nova semântica e foram ajustados explicitamente.
