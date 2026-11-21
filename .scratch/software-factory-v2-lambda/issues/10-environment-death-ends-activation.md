# 10: Morte do ambiente encerra a ativação

**What to build:** Na prova de continuidade, a ativação seguiu viva depois da morte do ambiente. Aqui isso deixa de acontecer: o adapter observa a
condição do ambiente pelo serviço em intervalo declarado, haja ou não chamada em curso. Cessação confirmada cancela a chamada em voo,
nega novas chamadas e faz o Controle encerrar a ativação. Observa-se o ambiente, não o trabalho: silêncio do agente ou comando longo
continuam não sendo motivo de parada.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-15 (gate obrigatório: a prova reprovou a ausência disto, I2).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 06

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] O adapter consulta a condição do ambiente pelo serviço no intervalo declarado no perfil, com ou sem chamada em curso.
- [x] Cessação confirmada com chamada em voo: a chamada é cancelada e devolvida como falha de ambiente encerrado.
- [x] Depois da cessação confirmada, toda nova chamada de ferramenta é negada.
- [x] O Controle encerra a ativação: nenhum pedido de modelo nem chamada de ferramenta acontece depois da cessação confirmada (asserção explícita no teste, por ser o gate obrigatório da spec).
- [x] Comando longo e agente silencioso com ambiente vivo não encerram nada; a regra "sem watchdog sobre trabalho silencioso" do MVP permanece.
- [x] Falha ao consultar o serviço não equivale a cessação: o resultado é desconhecido e a observação segue.
- [x] O encerramento registra o boot com o motivo observado, para os tickets de perda.

## Answer

A morte do ambiente passa a encerrar a ativação, sobre o fake da conta e o guest em processo. Nenhuma chamada AWS, nenhum
`ssh`/`websocat`, nenhuma MicroVM, nenhum modelo. Os testes do Sandbox foram escritos antes do código mas só rodaram depois dele (não foi
red-green estrito); vermelho real só no `write` dos Workers. A sensibilidade foi conferida por mutação, todas detectadas: dono que não
aborta os workers (a jornada composta acusa um pedido de modelo depois da cessação), "desconhecido" tratado como cessação, e trava não
entregue aos vínculos.

- **Vigia (no adapter, dentro do dono de ferramentas do boot).** `serveLambdaTools` (`src/sandbox/lambda/tools.ts`) faz uma leitura do
  serviço (`observeLambdaBoot`, a mesma do ticket 11) a cada intervalo, com ou sem chamada em curso. O intervalo vem do perfil e fica
  gravado no registro do boot (`boot.json.observationIntervalSeconds`); o Controle nunca o recebe. A espera entre observações é uma
  dependência própria (`LambdaBootDependencies.observationTimer`, `createSandbox({ lambdaObservationTimer })`,
  `ProductionInput.lambda.observationTimer`): timer real sem referência em produção, manual nos testes
  (`test/sandbox/lambda-observation-timer.ts`). Leitura que falha, `TERMINATING` ou registro ilegível são "desconhecido": o vigia segue.
  Observa-se o ambiente, não o trabalho: não há relógio sobre silêncio nem sobre duração de comando.
- **Cessação confirmada** (pelo vigia ou pela consulta de uma chamada que caiu, o ponto de roteamento do ticket 11) é uma trava: a
  chamada em voo tem a conexão fechada e responde `SANDBOX_ENVIRONMENT_ENDED` (`environmentEndedCode`, `tool-binding.ts`); toda chamada
  nova responde o mesmo código sem nada ir ao guest (`ReadBinding.environmentEnded`, checado em `serveReadTools`); `tools.bind` recusa
  `ENVIRONMENT_ENDED`; nada é reconectado. A chamada que tinha começado continua registrada como efeito incerto `environment-ended`.
- **Workers.** Depois que as chamadas canceladas responderam (`serveReadTools().idle()`), o dono do boot (`owner.ts`) aborta o sinal de
  vida de todo worker que lançou e recusa lançamentos novos. Em `src/workers/write.ts` o código novo virou crítico (Bash, edit e read já
  tratavam código desconhecido como crítico).
- **Controle.** Capacidade nova e opcional `environmentWatch` (o Lambda declara; o Gondolin não) e porta
  `ports.sandbox.awaitEnvironmentEnd({ environment, boot, signal })`, que resolve quando o sandbox confirma o fim. O despacho a chama logo
  depois do Iniciar e trata o fim como uma interrupção do escopo da atividade (`environment-ended`, ao lado de timeout, cancelamento e
  entrega): interrompe Builder, revisores e a ativação de publicação, retira as credenciais, grava `execution.environmentEnd`
  (`{ at, boot, reason, terminatedAt }`), encerra a Execução como `failure` / `SANDBOX_ENVIRONMENT_ENDED`, chama o Parar (que confirma pelo
  registro já encerrado, sem `TerminateMicrovm`) e libera o Slot. O Controle não ganhou timer nem watchdog.
- **Registro do boot.** `boot.json`: `phase: ended`, `end: { reason: 'loss', stateReason: <texto do serviço>, terminatedAt, at }`,
  `artifacts: lost`, `evidence.lost` (gravado por `observeLambdaBoot`, como no ticket 04).

### O que a asserção obrigatória cobre, e o que não cobre

`test/entrypoints/lambda-environment-death-composed.test.ts` roda a composição de PRODUÇÃO (Controle, Pi Durable, adapter Lambda, dono do
boot, ferramentas, vigia, fachada de Workers) e substitui a conta, o guest e o PROCESSO worker por um laço roteirizado: cada volta é um
"pedido de modelo" seguido de uma chamada de ferramenta, e o laço IGNORA chamadas que falham. Um único log ordenado registra pedidos de
modelo, chamadas e o instante em que o serviço responde `TERMINATED`. O teste afirma que, depois desse instante, o log não tem nenhum
pedido de modelo nem chamada nova (só a resposta `SANDBOX_ENVIRONMENT_ENDED` da chamada em voo), que o sinal do worker foi abortado e que
o Controle encerrou a Execução sem lançar mais nada naquele boot. Isso prova a ordem no dono do boot: o sinal de vida do worker é abortado
antes que o laço possa dar outra volta.

Não cobre: um processo worker real (SDK do agente + modelo). Lá o mesmo sinal faz o supervisor (`launchWorker`) enviar a diretiva `abort`
ao processo (não é SIGKILL) e a chamada que falhou aborta a sessão (`test/workers/environment-ended.test.ts`, ferramentas reais dos Workers
com o callback `critical`), mas nenhum pedido de modelo real foi contado. Um pedido de modelo já em andamento no instante da confirmação
não é cancelado por este ticket. Entre a morte e a confirmação (até um intervalo, 30 s por padrão, mais a leitura) o agente pode pedir
modelo: a regra é sobre cessação CONFIRMADA.

Outros testes: `test/sandbox/lambda-environment-death.test.ts` (intervalo, comando longo e agente silencioso, cancelamento, negação,
registro, falha de consulta), `test/control/environment-death-flow.test.ts` (Controle real com sandbox de teste), caso de perda de
`lambda-tools.test.ts` atualizado para o código novo.

### Limites e pendências

- O vigia vive no dono do boot, no processo do controlador. Se o controlador morre, ninguém vigia; a reconciliação de boot continua sendo
  a do `observe`. Boot gravado antes deste ticket (sem intervalo no registro) não é vigiado.
- Ambiente que morre antes do recibo de início do worker: a Execução fica retida com `ENVIRONMENT_ENDED_START_UNCONFIRMED` (não testado).
- **Mudanças não pedidas:** `SANDBOX_ENVIRONMENT_ENDED` entrou em `transient` (`src/control/rules/recovery.ts`), pela V2-10 (a perda
  encerra a Execução e a substituta volta pela fila consumindo uma retomada). O que acontece depois, neste perfil, não foi exercitado aqui
  (retomada sem disco: tickets 08 e 13). No caso de perda do ticket 11, os códigos das ferramentas passaram de "efeito desconhecido" para
  `SANDBOX_ENVIRONMENT_ENDED`.
- Nada rodou em conta real nem com modelo real.

`npm run test:ci` (2026-11-21): 1998 testes, 1976 passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base:
`test/sandbox/audited-vfs-guard.test.ts` (4) e `test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

### Para os tickets seguintes

- **12 (perda visível):** ler `execution.environmentEnd` e `end.code === 'SANDBOX_ENVIRONMENT_ENDED'` na Execução, e `end.reason === 'loss'`
  com `stateReason` em `sandbox.bootRecord`. A sessão antiga não é continuada por este ticket; conservar e registrar a perda é do 12.
- **13:** o efeito da chamada em voo está em `execution.indeterminateEffects` com `outcome: 'environment-ended'` (gravado pelo Parar da
  interrupção, via `recordChannelReport`).
- **14:** `startedAt` e `end.terminatedAt` do registro do boot são os instantes do serviço; `environmentEnd.terminatedAt` repete o segundo.
- **09 (troca planejada):** o vigia fecha com `tools.close()`; um boot novo ganha o seu ao subir o dono.

