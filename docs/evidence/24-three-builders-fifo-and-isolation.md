# 24 — Três Builders com FIFO e isolamento: incremento local

Autoridade: [ticket 24](../../.scratch/software-factory-mvp/issues/24-three-builders-fifo-and-isolation.md),
[spec §§3.3, 4.3, 7.3, 7.4, 12.1, 13.2](../../.scratch/software-factory/spec.md) (CA-03, CA-04, CA-05, CA-08), cenários V-02/V-06/V-12 da
[matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).
Base: branch do ticket 22 (`84ef010`, sobre o ticket 21 `4852185`), ainda não integrada. Branch `implement/software-factory-mvp-24`.

**Estado: implementação e suíte local verdes (níveis R/S/I-local); ensaio real NÃO executado** (sem GitHub/VM/credenciais/rede/modelo).
Receita em [§ Ensaio real](#ensaio-real-receita-one-shot). Nenhum checkbox marcado; ticket não resolvido. Dublê não comprova fronteira substituída.

## O que mudou

- **Despacho preenche todos os Slots livres numa passada** (`control/durable/dispatch.ts`, `tick`). Antes, cada ciclo do proprietário admitia no
  máximo um Trabalho: com capacidade 3, o terceiro Builder só começava dois ciclos de polling depois. Pior: se a revalidação própria do
  primeiro da fila falhasse (autorização retirada entre a leitura do polling e a do despacho, reparo não revalidado, base de retomada mudada,
  admissão recusada), o `tick` retornava, e os independentes atrás dele esperavam. Como essa falha não vira impedimento durável, ela se
  repetia a cada ciclo, o que viola o invariante 9 da spec §3.3. Agora a passada percorre a fila na ordem `queueOrder` (reparos primeiro,
  FIFO em cada categoria, sem preempção nem mutex global ou por repo). Cada candidato é revalidado e admitido isoladamente. Um candidato
  recusado é pulado só nesta passada e não perde a posição. A passada termina quando não há Slot livre (`heldSlots`, que inclui os
  incertos) ou candidato elegível. A capacidade continua conferida no commit de admissão (`NO_SLOT_AVAILABLE`).
- **Pré-condição de memória livre no boot, somada por passada (decisão 4)** (`sandbox/start.ts`, `sandbox/capacity.ts`, `platform/host` `inspectMemory`/`parseMeminfo`). Junto
  da pré-condição de disco que já existia, cada boot exige `MemAvailable ≥ memoryMiB + minFreeMemoryMiB`. O `minFreeMemoryMiB` é
  opcional, **sem default no schema**, para não mudar a identidade dos ambientes já preparados (`owner.json` é comparado por JSON exato);
  quando ausente, vale 1024 MiB. Abaixo disso o boot é recusado com `INSUFFICIENT_MEMORY_FOR_BOOT`, uma falha de start, nunca tentada de
  novo. É uma pré-condição, não uma reserva: boots simultâneos podem passar todos e depois competir, e nenhuma aritmética de admissão foi
  inventada.
- **Capacidade observada no `doctor`** (check `capacity`): Slots × limites do guest (memória, vCPU, disco virtual) contra MemTotal/MemAvailable,
  armazenamento livre e CPUs do host, observados no momento. Fica `blocked` só se nem um boot cabe agora. Se a observação não cobre
  todos os Slots no tamanho virtual cheio, o resultado é apenas `unverified`, porque memória e disco são alocados sob demanda. A
  mensagem diz que os limites são virtuais, não reservados, e que capacidade só se prova por execução medida.
- **Registro de recursos do ensaio real** (`test/entrypoints/three24-measure.ts`). O registro lê, só para leitura, o cgroup da unit própria de
  cada Trabalho (`factory-sandbox-<boot>.service`: adapter + QEMU + workers/revisores daquele boot), ou seja `memory.current`/`memory.peak`,
  `cpu.stat`, `io.stat` e o RSS por classe de processo. Lê também `meminfo`/`loadavg`/PSI do host. O armazenamento do guest (alocação
  qcow2, workspace, o que inclui Docker `vfs`) vem de `Sandbox.observe`. Um valor ilegível fica `null`, nunca zero.

## Mapa AC → evidência

Níveis: **R** regras puras; **S** Control real + Pi Durable/SQLite temporário + Records reais + dublês de borda (host Sandbox em arquivo,
Builder roteirizado, credenciais, GitHub); **I-local** componentes reais com fronteira externa substituída (git/flock reais, árvores fixture).
**A** (real) só pelo ensaio.

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Três Builders com branch/checkout/workspace/disco/VM próprios; dois no mesmo repo sem metadados graváveis comuns nem mutex global | `control/three-builders-flow` AC1/AC2: uma passada reserva 3 (sem avançar o relógio de polling); os 3 `started` ao mesmo tempo; ambiente, boot e branch distintos; mesmo repo; o 4º espera na fila. `sandbox/sandbox-checkout` "same repository is sequenced… Works share no writable metadata" (clone `--no-hardlinks`, sem alternates/shared) | S + I-local | VMs/discos reais: ensaio |
| 2 FIFO normal; reparos com prioridade/FIFO próprios sem preempção; impedidos ignorados sem perder posição; correção posterior com nova sequência | `three-builders-flow` AC1/AC2 (ordem por `sequence`, o Trabalho excedente mantém a posição) e AC2 (cabeça recusada na revalidação é pulada na mesma passada e mantém sequência e posição; o independente atrás inicia). `repair-rules` AC3 (reparos antes, FIFO por `repairSequence`, sem reordenar por evento); `repair-flow` AC1/AC2/… (correção posterior: `sequence` 2, categoria `repair`); `dependency-rules`/`selectNext` (impedidos não bloqueiam) | R + S | Prioridade de reparo na fronteira real: evidência do ticket 22 (este ensaio não provoca reparo) |
| 3 Pergunta e espera por CI/merge sem Slot após cessação; revisões no mesmo Slot/relógio; reservas incertas ocupam capacidade | `three-builders-flow` AC3 (Pergunta: Slot liberado após cessação e ocupado pelo próximo da fila; revisores de outro Trabalho no boot dele, `slots.held` 2 com 2 Builders + 2 revisores) e AC6 (incerteza mantém o Slot). `checks-flow` AC4/AC7 (espera de CI durável: nenhum Slot, fila ou impedimento); `timeout-flow` AC4 revisão (relógio compartilhado); `recovery-crash` AC5 | S | Real: ensaio (revisores medidos por `maxWorkersAtOnce`) |
| 4 Cache sequencia só fetch→cópia do mesmo repo; preparados e repos diferentes em paralelo; crash no preparo não muta cache com processo antigo | `sandbox-checkout` "same repository is sequenced fetch -> completed clone; distinct repositories proceed in parallel" e "review 9: cache mutation is serialised across processes by a per-repository flock; an interrupted mutation is refused"; `cache-reconciliation` (ticket 26) | I-local | Repos diferentes em paralelo não entram no ensaio (os 3 Trabalhos estão no mesmo repo; lacuna registrada, decisão 2) |
| 5 Containers simultâneos sem colisão de portas/volumes/nomes nem cleanup alheio; adequação explícita | Ensaio: os três gates usam o MESMO nome de container, a MESMA porta publicada e o MESMO volume, e cada um verifica a própria chave. Isso só passa com daemon/host próprios; as janelas devem se sobrepor (`containerWindows.overlapAll`) e o cleanup remove só o que é seu. Evidência 06: daemon/vfs/Testcontainers+Ryuk por VM; adequações aprovadas (userland-proxy, sem `bridge:none`, `safe.directory`) | A (v1: fixture provado; suite real pendente) + evidência 06 | v2 roda `./gradlew test` (decisão 3; v1 tentou `./mvnw`, inexistente); suites dos demais pilotos seguem obrigação do piloto |
| 6 Falha de worker/adapter/VMM de um Trabalho não encerra os outros nem libera capacidade incerta; nenhum substituto vira segundo escritor | `three-builders-flow` AC6: o Builder de #4 falha e o stop do boot não confirma a cessação. #3/#5 continuam `started`; `slots.held` fica 3; #6 não entra; #4 continua com a mesma Execução, sem nova; o Slot de #3 é liberado após a cessação dele e #6 entra. `recovery-crash` AC5 (sobrevivente incerto bloqueado, independente segue) | S | Real: ensaio (falha só se ocorrer; não há injeção) |
| 7 Registro de RAM/CPU/I/O/disco com overhead e vfs, workers/revisores, Slots/filas, configuração/host; limites virtuais não são reserva; sem SLA/teto | `three24-measure` (parsers, amostra por unit e host, resumo; desconhecido ≠ zero; unit ausente não gera número); `sandbox/capacity` (pré-condição de boot; diagnóstico mostra totais virtuais × observação, nunca "comprovado"). Ensaio grava `registry {configuration, capacity, hostRequirements, summary, samples, hosts, storage, slots}` | R + I-local (+A pendente) | Valores reais só no ensaio |
| 8 Regras automatizadas e composição real com agentes demonstram prioridade, retomada na posição certa e independência | Itens 2, 3 e 6 (S); ensaio (A) para concorrência, independência e Docker | R + S (+A pendente) | Reparo e retomada após Pergunta na fronteira real: tickets 22/10 |

TDD observado: `three-builders-flow` foi escrito primeiro e falhou nos 4 testes com o despacho antigo (AC1 sem 3 ativações; AC2 com o
independente nunca ativado; AC3 com o terceiro Trabalho fora da passada; AC6). Depois da passada que preenche os Slots, ficou verde (12
execuções consecutivas sem falha). Os testes de `capacity`, `three24-measure` e da receita passaram na primeira execução depois de compilar.

## Decisões do supervisor/operador (registradas)

1. **`Control.run()` continua relatando `clean`** quando uma Execução que terminou ANTES do stop, com cessação não confirmada, mantém
   o Slot (`three-builders-flow` AC6). Isso é intencional (ticket 33). Essa Execução é atividade não assentada e bloqueia upgrades por
   outro caminho (`unsettledExecutions`); a parada em si é limpa. Nada foi alterado.
2. **Ensaio real:** 3 VMs × 2048 MiB / 2 vCPU, os três Trabalhos no mesmo repo. **Lacuna:** "repos diferentes em paralelo" fica provado
   só localmente (`sandbox-checkout`, I-local).
3. **Suite real:** os corpos das três issues rodam a suite real do repo além do fixture de colisão. Em v1 era `./mvnw -B verify`, que não
   existe (repo Gradle); em v2 é `./gradlew test` (README; Testcontainers/Docker no guest). Um OOM do guest é registrado como achado, nunca vira retry.
4. **Memória de boots simultâneos:** decisões serializadas e soma dos limites dos boots ainda lançando (de qualquer passada; ver a correção
   HIGH acima). A identidade da passada (`pass`) chega a `Sandbox.start` e é evidência (`three-builders-flow` AC1: três starts com o mesmo
   `pass`, e uma passada posterior com outro).
5. Criação das issues sintéticas, fixação dos números e todo passo humano/administrativo são do supervisor. Os números ficam 0 até a
   fixação.

## Correções da revisão independente (dcc4d93)

| Achado | Correção | Teste |
| --- | --- | --- |
| HIGH: o ledger por passada subtraía duas vezes um boot da mesma passada que já estava rodando (ele aparece em MemAvailable E na soma), e o 3º boot era recusado indevidamente | Um único modelo: o ledger do Sandbox guarda só boots **lançando**, de qualquer passada. Um boot entra quando é admitido e sai quando o seu `start` retorna (operacional confirmado, falha ou indeterminado; `release` idempotente). A partir daí só MemAvailable o conta. `pass` virou só correlação/evidência | `sandbox/capacity` "decision 4 (review)": 2 simultâneos → 1 admitido; boot de passada posterior enquanto o 1º lança → recusado; após `release` não há dupla contagem; 3 boots com minutos de intervalo → todos admitidos |
| MED: boot ainda preparando/lançando de uma passada anterior era invisível para a próxima | O ledger cobre todas as passadas, sem expiração; uma entrada só sai pelo próprio `release` (um boot inacabado nunca é removido) | idem ("an unfinished boot is never evicted") |
| MED doctor: guests em execução eram lidos como capacidade bloqueada; meminfo ilegível dava `blocked` | `runningGuests` (units `factory-sandbox-*` ativas no user manager do systemd, `parseSandboxUnits`). Só os Slots livres são julgados: sem Slot livre → `unverified`. Fato do host ilegível → `unverified` com "unknown" (o `Diagnostic` não tem status `unknown`) | `sandbox/capacity` "review: own running guests…", "unreadable meminfo is unknown, never blocked" |
| MED receita | (a) pré-condições do host (memória/disco/CPU, `/dev/kvm`, user manager do systemd `running`/`degraded`, nenhuma unit `factory-sandbox-*` ativa nem processo `qemu-system*`, recusados com nomes) checadas ANTES de `mkdir`/intent na `preflight` e de novo ANTES do intent no `run`: uma leitura baixa momentânea não consome nada. (b) o `pass` recebido por `Sandbox.start` é registrado por ambiente, e `one-pass-reservation` exige uma única identidade observada. (c) cgroup obtido do systemd (`ControlGroup`, `acceptCgroup`), nunca `app.slice` fixo; `resources-measured` reprova se todas as amostras faltam. (d) `finally`: espera limitada (5 min) do stop do Control; boots do log de start da própria receita quando a view não pode ser lida (também no `stop-environment`). (e) Trabalho que sai sem recibo de início, ou janela de 25 min sem os três iniciados → o run para com `WORK_NEVER_STARTED:<n>:<code>` | `three24-qualification` (host precondition, verdict com passes/amostras, `neverStarted`, `startedBoots`); `three24-measure` (`acceptCgroup`, slice não padrão) |
| LOW: leituras de autorização ilimitadas por passada | `refusalsPerPass = 4`: após 4 recusas não duráveis a passada termina e o restante espera, mantendo a posição. Consequência documentada: enquanto 4 Trabalhos à frente seguirem recusados, os de trás esperam (o limite é de leituras, não de ordem) | `three-builders-flow` "review LOW" |

## Questões abertas

- Depois que um boot fica operacional, a RAM do guest que o kernel ainda não alocou (o QEMU aloca sob demanda) não é contada: o critério é a MemAvailable do momento, e o registro do run mede o pico real.

## Ensaio real v1 (`y5/q24-three-v1`, issues #21–#23): executado pelo supervisor, HELD

Autorizado pelo operador e executado pelo supervisor (não por este agente). Resumo derivado (sem texto de sessão nem segredo) em
[24-real-q24-three-v1-summary.json](24-real-q24-three-v1-summary.json), lido só por cópia. O teste `three24-qualification` "v1 offline proof"
recalcula o veredito sobre esse resumo.

- **Causa do hold (`PHASE_NOT_AS_EXPECTED`): expectativa errada da receita, não defeito do produto.** O gate `./mvnw -B verify` (decisão 3)
  não existe no repo, que usa Gradle (`./gradlew` presente). Os três Builders receberam exit 127. O Builder de #23 fez uma Pergunta
  (`9d53dab9…`): o gate exigido não roda como escrito; pediu dispensa ou o comando exato permitido. É comportamento correto do modelo:
  não inventou um comando nem contornou o gate. A Execução terminou `question`, com cessação confirmada e o Slot liberado.
  `runSettled` só aceitava `completed`.
- **Provado offline com os dados v1 (nível A):** as três Execuções foram reservadas na MESMA passada (`pass` `97d421ec…` registrado nos três
  starts; spread de 3,6 s). Ambiente, boot e branch são próprios. O fixture de colisão Docker (mesmo nome/porta/volume, chave própria)
  passou nas três VMs, com janelas sobrepostas: A 284–358, B 304–379, C 284–360 (epoch 1794794xxx). Para #21/#22, os revisores
  Standards/Spec rodaram no boot do próprio Builder (`maxWorkersAtOnce` 3 na unit) sem Slot extra. Execuções #21/#22 `completed`; todos
  os boots parados com cessação confirmada; Slots liberados só depois disso. Registro por unit: pico de `memory.current` de 1,82/2,41/2,39 GB
  (guest de 2 GiB + adapter ~0,2 GB + workers até 0,57 GB) e CPU de 78/115/120 s.
- **Não provado em v1:** a suite real com Testcontainers/Ryuk simultâneos (o comando não existia). I/O por unit: `io.stat` ilegível nas units de
  usuário, então ficou `null` (desconhecido, nunca zero).
- **Gates em #21/#22 (correção: não é defeito):** "completed" é só o desfecho da sessão do Builder. No storage v1, a verificação do controlador
  ficou `not-verified` em ambos: #22 com `GATE_FAILED:repository-test-suite` e #21 com `GATE_NOT_RUN:repository-verify`. Nada podia ser
  publicado. O gate não executado ou falho não virou verde, como exige a spec.
- **v2:** namespace `y5/q24-three-v2`, números das issues de volta a 0. Suite real fixada pelo supervisor: `cd /workspace/checkout && ./gradlew test`
  (o README do repo documenta `./gradlew test`, que exige Docker para Testcontainers), além do fixture de colisão. Sem comando, as fases são
  recusadas (`SUITE_COMMAND_NOT_PINNED`). Uma Pergunta de Builder fica registrada como achado
  (`QUESTION_ASKED:<n>`; a fase é retida, nunca repetida).

## Ensaio real v2 (`y5/q24-three-v2`, issues #39–#41): executado pelo supervisor, HELD

Resumo derivado em [24-real-q24-three-v2-summary.json](24-real-q24-three-v2-summary.json); veredito recalculado no teste "v2 offline proof".

- **Causa do hold (`QUESTION_ASKED:39;QUESTION_ASKED:41`): gate da receita inexecutável no perfil do guest, não defeito do produto.**
  `cd /workspace/checkout && ./gradlew test` sai com 1 porque o `gondolin-qemu-alpine-dev-v1` não tem Java (JAVA_HOME não definido). Os
  Builders de #39 e #41 perguntaram, o que é o comportamento correto. #40 terminou `completed` na sessão, mas a verificação do controlador
  ficou `not-verified` [`GATE_FAILED:repository-tests`] (gate q24 `passed`, suite `failed`): nenhum sucesso falso.
- **Provado (A):** 3 VMs preparadas e iniciadas numa única passada (`pass` `dbbc32b1…` nos três starts), capacidade 3 com no máximo 3 Slots
  mantidos, ambiente/boot/branch próprios, Perguntas independentes por Trabalho (uma Execução terminou `question` enquanto as outras
  seguiram), Slots liberados após cessação confirmada, unidades medidas (#40 com revisores: 3 workers na unit). O host passou na checagem
  (MemAvailable 10,3 GB). Isso confirma, numa segunda execução, os itens de AC1/AC3/AC6/AC7 provados em v1.
- **Ainda não provado → v3 necessário:** a suite real com Testcontainers/Ryuk simultâneos nas três VMs (AC5) e as três Execuções
  `completed` com verificação.
- **v3:** namespace `y5/q24-three-v3`, números das issues 0. A suite roda `./gradlew --no-daemon test` (README: JDK 25 + Docker) dentro de
  `eclipse-temurin:25-jdk` no Docker do próprio guest, com `--network host` (egress mediado do guest e portas publicadas), o socket do
  daemon do guest (Testcontainers + Ryuk, nunca o socket do host), a CA Gondolin do boot adicionada à truststore do JDK
  (`USE_SYSTEM_CA_CERTS`: TLS em camadas, sem bypass) e um volume nomeado para o Gradle home. A regra pura `profileGateViolations` recusa
  ferramenta JVM fora de container e imagem sem versão fixada (`SUITE_NOT_EXECUTABLE_IN_GUEST`).
  **Não verificado offline:** alcance da imagem e do download do Gradle/dependências pelo egress do guest, e duração. Pull ou estouro de
  tempo vira achado registrado, nunca repetição.

## Ensaio real v3 (`y5/q24-three-v3`, issues #44–#46): executado pelo supervisor, HELD (veredito 4/6)

Resumo derivado em [24-real-q24-three-v3-summary.json](24-real-q24-three-v3-summary.json); teste "v3 offline proof".

| Trabalho | Observado | Classificação |
| --- | --- | --- |
| #44 (A) | A suite real **rodou** em `eclipse-temurin:25-jdk` no Docker do guest: download do Gradle 9.5.1 e Testcontainers/Postgres com Ryuk funcionaram e 117 testes completaram. Na 1ª execução 1 falhou (`CreditAccountUseCaseConcurrencyIT` NPE), na 2ª 2 falharam (outro teste do mesmo IT e `JdbcOutboxEventAdapterIT`). Verificação `not-verified` [`GATE_FAILED:repository-test-suite`] | **Repositório/ambiente:** ITs de concorrência instáveis num guest de 2 vCPU com `vfs` (falhas diferentes a cada execução). Não é defeito da Factory, que não deu verde |
| #45 (B) | `git status --short && git config user.name && git config user.email && docker info …` deu **(sem saída) exit 1** e o Builder perguntou atribuindo a falha ao Docker. `docker info` imprime `vfs` ou um erro, então a cadeia parou antes, em `git config user.name` (sem valor ⇒ exit 1). O adapter tinha confirmado `docker info` = vfs ao ficar operacional, e nenhum gate foi executado | **Comportamento do modelo** (diagnóstico errado), não Docker nem pressão de memória: VMM RSS 0,6 GB e MemAvailable do host ≥ 6,4 GiB nesse momento |
| #46 (C) | Gate Docker passou; o wrapper falhou com `Downloading …gradle-9.5.1-bin.zip failed: timeout (10000ms)` (`networkTimeout=10000`, `retries=0` do repo) pelo egress mediado sob carga de 3 VMs | **Ambiente + receita:** a receita dependia do download do wrapper com 10 s. Corrigido em v4 (abaixo) |

- **Provado em v3 (A):** de novo uma passada (`pass` `3a318d26…`, spread de 4 s), três VMs, ambiente/boot/branch próprios e units medidas. Também
  provado: **Testcontainers + Ryuk reais da suíte do repo funcionando dentro do guest** (#44), e fixtures Docker sobrepostos em duas VMs
  (A e C). Pico de `memory.current` de #44: 7,2 GB, que inclui o page cache do I/O do `vfs`/qcow2; MemAvailable do host chegou a 2,66 GiB.
  Isso é dado medido, não teto.
- **v4 (receita, não executada):** o guest pré-provisiona a distribuição do wrapper uma única vez (busybox `wget -T 600`, uma tentativa,
  conferida contra o `.sha256` publicado) no layout do Gradle (`wrapper/dists/gradle-9.5.1-bin/<base36(md5(url))>`, testado), num
  diretório do guest montado como Gradle home. O comando do README não muda. Namespace `y5/q24-three-v4`, números 0.
- **Recomendação:** o AC5 "containers simultâneos sem colisão" já está provado pelo fixture (v1: três VMs sobrepostas; v3: duas), e a suíte
  real com Testcontainers/Ryuk roda no guest (v3 #44). O que falta, "três suites reais verdes ao mesmo tempo", depende dos ITs de
  concorrência instáveis do repositório (falhas diferentes a cada execução sob 2 vCPU). Um v4 só vale se o operador aceitar esse risco ou
  der mais vCPU/memória por guest (o host limita a ~2 GiB × 3). Caso contrário, registrar como limite do ambiente/piloto para decisão do
  operador.

## Ensaio real (receita one-shot)

Receita: `dist/test/entrypoints/three24-qualification.js` (fonte `test/entrypoints/three24-qualification.ts`; registro
`three24-measure.ts`). `--plan` é inerte (teste `three24-qualification`). **Não executado.** Requer autorização explícita do operador para esta
execução: GitHub real (App; grants só de leitura, sem push/PR), três VMs Gondolin/KVM reais e o modelo real (3 Builders + revisores).

- Namespace próprio `y5/q24-three-v4` (v1, v2 e v3 consumidos). A `preflight` falha alto se `y5/credentials/app.pem` estiver ausente; depois faz `mkdir` exclusivo do
  namespace e grava o tombstone `preflight-intent`; só então cria `credentials/`/`run/` e copia a chave com `COPYFILE_EXCL`. A cópia é removida
  no `finally` do `run`, ou da `preflight` retida. Fases: `preflight`, `run`, `inspect`, `stop-environment`, cada uma uma única vez,
  sempre após uma `preflight` com sucesso.
- Três issues sintéticas NOVAS no `Sanmoo/java-springboot-event-sourcing` (títulos/corpos no plano, label `ready-for-agent`, sem PR associado).
  `tickets[].number = 0` recusa qualquer fase (`TICKETS_NOT_PINNED`) até um commit revisado fixar os números.
- `run`: storage novo, `capacity: 3`, revisões `{rounds max 2}`. Uma passada reserva as três Execuções. Assim que as três iniciam, a receita
  dá `pause` (nenhuma ativação de publicação/reparo; as atividades continuam). Amostras a cada 15 s (cgroup de cada unit + host) e
  armazenamento do guest a cada 60 s. A fase termina quando as três terminam e liberam o Slot, ou com hold/prazo de 100 min. O `finally`
  para todo boot ainda ativo dos três Trabalhos e grava `run-cessation`.
- Guardas: um prepare por Trabalho fixado, um Builder `builder-initial` por Trabalho (no máximo 3), revisores só da própria Execução e em
  rodadas distintas, `builder-publish` sempre recusado, mais de 6 recusas de guarda param o run. Sem retry, remove ou cleanup.
- `inspect`: cópia do storage, sessões JSONL (limitadas: comandos bash e janelas `Q24_WINDOW_*`), inspeção read-only de cada checkout por cópia
  bare própria, `verdict` (três Execuções; ambiente/boot/branch distintos; reserva na mesma passada; `completed` + cessação confirmada;
  janelas Docker sobrepostas).

**Configuração proposta (a menor fiel) e requisitos do host assumidos.** São 3 guests de **2048 MiB / 2 vCPU / 40 GiB virtuais**
(`minFreeSpaceGiB` 4, `minFreeMemoryMiB` 1024). A opção de 3 × 4 GiB foi descartada: este host tem 8 CPUs e ~15,7 GiB de RAM, com
MemAvailable observado de ~8 GiB nesta sessão. Os 12 GiB de guests não deixariam espaço para host, adapters, workers e revisores. A
preflight recusa abaixo de **MemAvailable ≥ 9216 MiB** (6 GiB de guests + ~1 GiB por Trabalho), **≥ 132 GiB livres** em `y5`
(3 × (40 + 4), exigidos por cada boot, porque o qcow2 cresce sob demanda) e **≥ 6 CPUs**. Também assume `/dev/kvm`, o user manager do
systemd e nenhuma outra VM da Factory ativa. Recomendação: fechar as cargas pesadas do host antes de autorizar.
