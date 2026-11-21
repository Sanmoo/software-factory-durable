# 04: Boot Lambda: iniciar, canal, observar e parar

**What to build:** Um boot completo no Lambda, sem agente: iniciar uma MicroVM da imagem preparada, estabelecer o canal, clonar o commit de partida no
guest, rodar um comando, observar e parar. Iniciar é sempre um boot novo, nunca adoção de sobrevivente. Nenhum processo vem do snapshot:
`dockerd`, `sshd` e a host key nascem no hook de início; as imagens Docker declaradas são baixadas por digest a cada boot.

O canal é SSH transportado em WebSocket pelo `HTTP_INGRESS`, com componentes prontos; `SHELL_INGRESS` e servidor exec próprio não são
usados. Referência: branch `prototype/v2-lambda-microvms` e os [resultados da prova](../../software-factory-v2/research/lambda-proof-results.md).

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-02 (Iniciar, Observar, Parar), V2-09 (suspensão desligada), V2-10 (registro de boot), V2-20, V2-22, V2-24 (transporte), V2-25, V2-28, V2-34.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 03

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Iniciar faz `RunMicrovm` com tags de instalação e de Trabalho, sem execution role, com a suspensão automática por ociosidade desligada, e só devolve sucesso com o canal estabelecido e o commit de partida clonado do `origin` no guest.
- [x] Credenciais do transporte: chave SSH de sessão por boot gerada no host e entregue no payload do hook de início; host key gerada no boot e fixada pelo host; token do serviço por porta. Conexão com host key diferente da fixada é recusada.
- [x] O adapter mantém keepalive no canal. Retirar acesso é fechar a conexão ou encerrar a MicroVM; o código não depende do vencimento do token para isso.
- [x] Observar devolve a condição pelo serviço (`GetMicrovm`) e funciona sem o processo que criou o boot.
- [x] Parar faz `TerminateMicrovm` e só confirma cessação quando o serviço confirma; não preserva disco. Cessação não confirmada é resultado indeterminado, nunca sucesso.
- [x] Cada boot é registrado com identidade, motivo (início, troca planejada, perda ou fim), tamanho, início e fim.
- [x] O boot usa `INTERNET_EGRESS` e o adapter declara a saída como capacidade: qualquer destino público IPv4 por TCP, sem mediação nem filtro; sem UDP e IPv6 de saída; sem VPC (V2-25).
- [x] Cada boot começa sem caches e sem dados do Docker; as imagens Docker declaradas são baixadas por digest no início.
- [x] Credenciais AWS ficam só no host; nada do host além do payload do hook e do que passa pelo canal chega ao guest.
- [x] A evidência do guest é a que o host coleta pelo canal; o que não foi coletado antes de uma morte é declarado perdido.
- [ ] Smoke em conta AWS real, no perfil de aceite (`us-east-1`, ARM64), com evidência registrada no `## Answer`. Exige autorização específica do Operador antes de rodar (conta, permissões, teto de consumo, prazo e cleanup), conforme `docs/agents/experiment-proofs.md`. Sem autorização, o critério fica desmarcado e declarado; nunca é dado por feito pelo fake.

## Answer

Um boot Lambda completo, sem agente, funciona sobre o fake da conta e um guest em processo; nenhuma chamada AWS real foi feita, nenhum
`ssh`/`websocat` rodou e nenhuma MicroVM foi iniciada. Os testes foram escritos depois do primeiro corte do código (não foi red-green
estrito); a sensibilidade deles foi conferida por mutação (tags, cessação não confirmada, retirada da chave, adoção de boot anterior, pull
falho, perda), e as duas lacunas achadas (commit divergente, chave removida na perda) ganharam teste.

- **Porta do serviço:** `LambdaService` ganhou `runMicrovm`, `microvm` (GetMicrovm), `terminateMicrovm`, `createAuthToken` e a falha
  `capacity` (`src/sandbox/lambda/service.ts`, `cli-service.ts`). O pedido de RunMicrovm não tem campo de execution role nem de idle
  policy: nenhum dos dois pode ser pedido pela porta. O fake (`test/sandbox/lambda-service-fake.ts`) modela MicroVMs sobre o relógio
  falso (`PENDING`, `RUNNING`, `TERMINATING`, `TERMINATED`, vida máxima, latência do fim ou fim nunca confirmado, run hook falho, recusa do
  Run) e tokens por MicroVM e porta com vencimento; `kill(id)` mata uma MicroVM, `admits()` decide uma conexão nova como o proxy do serviço.
- **Costura do canal:** `GuestTransport` em `src/sandbox/lambda/transport.ts` (`readHostKey` no primeiro contato, `exec` de um programa
  por conexão). Produção: `createSshTransport` (`ssh-transport.ts`), o cliente OpenSSH do host com `ProxyCommand` = `websocat` e o token
  no header `X-aws-proxy-auth`; `ssh` e `websocat` viram pré-requisitos do host. Testes: `lambdaGuestFake(conta)`
  (`test/sandbox/lambda-guest-fake.ts`), sem processo, socket ou porta; injeção por `createSandbox({ lambdaTransport, lambdaBootClock })`.
  `openChannel` (mesmo arquivo) é o canal do adapter: host key fixada, chave de sessão, keepalive de 15 s em toda conexão, token emitido
  pelo host quando uma conexão precisa (um boot dura mais que um token), `close()` corta as conexões abertas e recusa novas.
- **Iniciar** (`startLambdaBoot`, `src/sandbox/lambda/boot.ts`; `createSandbox().start` com `checkout: { repository, commit, branch?,
  credential: { token } }` e `reason: 'start' | 'planned-swap'`): RunMicrovm da imagem do Trabalho (`readWorkImage`) com as tags de
  instalação e de Trabalho, `HTTP_INGRESS`, `INTERNET_EGRESS`, duração máxima do perfil; espera `RUNNING`; fixa a host key; espera o
  script de início (`boot-done`, exige o pull por digest das imagens declaradas); clona o `origin` no guest e confere o `HEAD`. Sucesso só
  com tudo isso. Boot anterior que o serviço não dá por encerrado recusa o início (`PREVIOUS_BOOT_NOT_CEASED`): nunca há adoção. Falha
  depois de existir MicroVM encerra a MicroVM; fim não confirmado vira `indeterminate`.
- **Credenciais (V2-24):** chave de sessão ed25519 gerada no host por boot (`generateSessionKey`); só a pública vai no payload do hook
  (`{"builder": "ssh-ed25519 ..."}`), a privada fica em `<raiz>/lambda/works/<ambiente>/boots/<boot>/session_ed25519` (0600) e é apagada
  no Parar e na perda. O token do Builder vai como ambiente de processo (`FACTORY_GIT_TOKEN`), usado por um credential helper em memória
  na linha de comando do `git clone`; não entra em script, arquivo do guest, URL do remote nem registro do host.
- **Observar** (`observeLambdaBoot`): condição do `GetMicrovm`, lida por qualquer processo a partir do registro do boot (perfil AWS pelo
  nome, região, id). `TERMINATED` sem Parar pedido é gravado como perda. Leitura negada, `TERMINATING` ou registro sem id: `indeterminate`.
- **Parar** (`stopLambdaBoot`): coleta a evidência pelo canal, apaga a chave de sessão, pede `TerminateMicrovm` e só devolve sucesso com
  `TERMINATED` lido do serviço (uma leitura a cada 2 s, até 120 s); senão `CESSATION_NOT_CONFIRMED`, `indeterminate`. Nada do disco fica.
- **Registro de boot (V2-10):** `boot.json` com identidade (boot, MicroVM, imagem, Trabalho), motivo de início (`start`,
  `planned-swap`) e de fim (`planned-swap`, `loss`, `end`), tamanho (do perfil: o GetMicrovm não informa), início e fim do serviço.
  Leitura: `sandbox.boots({ environment })`, `sandbox.bootRecord({ environment, boot })`; `current.json` aponta o último boot.
- **Evidência (V2-34):** os logs de boot do guest são lidos pelo canal no início e no Parar (`evidence/start.log`, `stop.log`); boot
  que morre sozinho, ou coleta final que falha, deixa `evidence.lost` dizendo desde quando a evidência se perdeu.
- **Saída (V2-25):** `SandboxCapabilities.egress` ganhou `udp`, `ipv6` e `privateNetwork`; o Lambda declara TCP público sem mediação e os
  três em `false`. O Gondolin declara os três em `false` também (mediação HTTP).

Formas não provadas, cada uma isolada:

- **Tags no RunMicrovm:** `runMicrovmCommand` em `cli-service.ts` passa `--tags`. O RunMicrovm não tem campo de tags documentado e
  nenhuma prova marcou uma MicroVM. Se o serviço recusar, é o único ponto a mudar; o inventário do ticket 15 cai nas tags da imagem mais os
  registros de boot do host.
- **Suspensão desligada** por omissão de `--idle-policy` (inferido da documentação; as provas rodaram assim).
- **Fixação da host key:** `readHostKey` em `ssh-transport.ts` usa `StrictHostKeyChecking=accept-new` no primeiro contato, pelo túnel já
  autenticado com o token desta MicroVM. A prova lia a host key por uma porta de diagnóstico que a produção não tem.
- **Ambiente pelo canal:** `remoteCommand` em `ssh-transport.ts` entrega `NOME=valor` no stdin (terminados em NUL) a um bootstrap fixo
  que exporta e faz `exec` do programa. Testado com `bash` local, nunca por `sshd` real.
- **Clone com o token reduzido:** `cloneProgram` em `guest-programs.ts`, por HTTPS com credential helper em memória. Testado com `git`
  local contra um repositório em arquivo (o helper não é exercitado); a prova só clonou com deploy key.
- **Classificação de erros do cliente `ssh`:** `classify` em `ssh-transport.ts`. Só o 403 e o exit 255 foram observados. Um programa do
  guest que saia com 255 é lido como conexão perdida.
- **Token do proxy no host:** fica na lista de argumentos do `websocat` (como na prova), visível a processos do mesmo host.
- **Recusa por quota ou capacidade** (`capacity` em `classify` de `cli-service.ts`) e **token para MicroVM encerrada** (suposição do fake).
- **Multiplexação:** não usada. Cada programa abre uma conexão (como a prova); o limite observado é de 16 conexões simultâneas.
- **Script de início e agente dos hooks** (ticket 03) continuam sem rodar num guest; este ticket não os alterou (o pin não mudou).

Pendências e limites:

- **Smoke em conta real: não executado, sem autorização do Operador.** O critério fica desmarcado; nada acima foi observado numa conta.
- "Cada boot começa sem caches e sem dados do Docker" é propriedade do serviço e do script de início; aqui está garantido o que cabe ao
  adapter (MicroVM nova a cada início, nada reaproveitado, pull exigido antes do sucesso) e modelado no guest falso.
- O Controle continua sem compor o Lambda: `composeProductionExecution` recusa com `SANDBOX_ADAPTER_UNAVAILABLE` e o `doctor` mantém
  `sandbox-adapter` bloqueado (texto atualizado). Só a recusa de `createSandbox().start` foi levantada. Falta para os tickets seguintes:
  - **05:** ferramentas por papel sobre `sandbox.openChannel` / `openLambdaBootChannel` (hoje só `builder`; `GuestUser`, o payload do hook
    e o `sshd_config` precisam do usuário revisor, o que muda o pin); `executeTool` ainda é o do Gondolin (dono do boot em socket Unix);
    entregar o token do Builder por `environment` a cada chamada que fale com o `origin` (o clone não deixa credencial configurada).
  - **06:** compor a Execução de produção (`composeProductionExecution`, check `sandbox-adapter`); o despacho exige `checkout` no resultado
    do Preparar (`PREPARE_CHECKOUT_MISSING`) e precisa passar `checkout`/`reason` ao Iniciar com o grant do Builder; o lançamento de workers
    está preso ao dono do boot Gondolin/systemd (`workerOwnerEndpoint`, `src/platform/host/worker-launch.ts`); códigos novos do Iniciar
    (`MICROVM_*`, `CHANNEL_*`, `CLONE_FAILED`, `DECLARED_IMAGE_PULL_FAILED`, `STARTING_COMMIT_MISMATCH`, `PREVIOUS_BOOT_NOT_CEASED`,
    `CESSATION_NOT_CONFIRMED`) ainda não têm tratamento no Controle; `ExecutionPorts` não deve receber o perfil.
  - **11:** `exec` devolve `lost` (sem status de saída) e `refused` (nada rodou); reconexão, encerramento do órfão e resultado
    indeterminado são daquele ticket. **12/10:** a perda é gravada quando alguém observa ou para; não há vigia.
  - **14:** `MICROVM_CAPACITY_REFUSED` e os instantes `startedAt`/`terminatedAt` do registro são a base do consumo; segundos não são somados.
  - **15:** registro em fase `requested` sem id (RunMicrovm sem resposta legível, `MICROVM_START_UNCONFIRMED`) depende do inventário por tag.
- `doctor` não confere `ssh` nem `websocat`. Processos diferentes gravam o mesmo `boot.json` por troca atômica, sem lock.
- `npm run test:ci` (2026-11-21): 1951 testes, 1929 passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base:
  `test/sandbox/audited-vfs-guard.test.ts` (4) e `test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

Testes: `test/sandbox/lambda-boot.test.ts`, `lambda-ssh-transport.test.ts`, mais casos em `lambda-cli-service.test.ts`; ajustes em
`adapter-selection`, `lambda-image`, `lambda-profile`, `release-composition` e nos dois testes de capacidades do Controle.
