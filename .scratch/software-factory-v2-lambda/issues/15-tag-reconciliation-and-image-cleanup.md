# 15: Reconciliação por tag e cleanup de imagens

**What to build:** Depois de um crash do controlador, nenhuma MicroVM fica rodando sem dono. A Factory inventaria os recursos pela tag da instalação e
encerra MicroVMs sem proprietário vivo. Imagens de MicroVM ficam enquanto houver Trabalho aberto com a chave e saem só por cleanup
explícito.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-33, V2-34.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 03, 06

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Todo recurso AWS criado pela Factory leva tags de instalação e de Trabalho (verificado para MicroVM, imagem e artefatos de build).
- [x] Na subida do controlador depois de crash, o inventário por tag encerra MicroVMs sem Execução viva que as possua, com cessação confirmada e registro.
- [x] MicroVM de outra instalação (outra tag) nunca é tocada.
- [x] MicroVM com proprietário vivo não é encerrada pela reconciliação.
- [x] Imagem de MicroVM não é removida enquanto houver Trabalho aberto com a chave; sai só por comando explícito de cleanup, que recusa imagem em uso.
- [x] Um cenário real de SIGKILL do controlador com boot em curso (fora do tier `fast`), seguido de reconciliação; as variações são testes de regra pura.
- [x] A evidência de ciclo de vida usada é a de `GetMicrovm`; a documentação registra que Run/Terminate não aparecem no CloudTrail por padrão.

## Answer

Entregue sobre o fake da conta e o guest em processo; nenhuma chamada AWS real, nenhum `ssh`/`websocat`, nenhuma MicroVM.

- **Inventário na subida do controlador (V2-33).** `composeRuntimeInventory` (`src/entrypoints/controller/composition.ts`) é o passo que o
  `owner.ts` já fazia depois do lock e antes de abrir o armazenamento (caches Git + `inventoryRuntime`), agora com
  `reconcileLambdaRuntime` (export do Sandbox; `src/sandbox/lambda/reconciliation.ts`). O Controle não mudou e continua sem conhecer o
  adapter: recebe o mesmo `RuntimeInventory`.
  - *De quem é a MicroVM:* `ListMicrovms` (operação nova da porta, `listMicrovms`) mostra a conta inteira. É da instalação a que leva a
    tag da instalação; como a listagem observada não mostra tags de MicroVM, vale então a imagem: nome `factory-<instalação>-<32 hex>` E
    tag da instalação na própria imagem (`GetMicrovmImage`). O resto é só contado: não é lido por id, alterado nem registrado.
  - *MicroVM detida por registro de boot não encerrado:* listada em `environments` com o Trabalho. Quem encerra é o Controle, pela regra
    do MVP (`reconcileBoot`: Execução não viva tem o boot parado por `sandbox.stop`, confirmado por `GetMicrovm`; nunca adoção), e o
    registro é o `RecoveryRecord` da Execução mais o `boot.json`.
  - *MicroVM que nenhum registro detém* (o `RunMicrovm` respondeu a um processo que morreu antes de gravar o id): nenhuma Execução pode
    possuí-la, então o próprio inventário pede `TerminateMicrovm` e confirma por `GetMicrovm`. Fim não confirmado, ou imagem ilegível,
    vira recurso desconhecido (`lambda/microvm/<id>`) e mantém o despacho fechado.
  - *Início sem resposta* (registro `requested` sem id, pendência do ticket 04): fechado (`ended`, `MICROVM_START_UNCONFIRMED`) só quando
    a listagem foi lida e tudo o que ele poderia ter deixado foi confirmado encerrado; antes disso o Controle mantém o Slot.
  - Listagem recusada ou ilegível: inventário `unknown` (despacho fechado, nada encerrado) e `RUNTIME_INVENTORY_UNKNOWN` no stderr do controlador.
  - Registro: `<raiz>/lambda/reconciliations/<instante>-<uuid>.json` quando o inventário achou algo (cada MicroVM, ação, cessação e os
    instantes do `GetMicrovm`).
- **Critério "proprietário vivo".** No adapter, é detida a MicroVM de um registro de boot não encerrado: o inventário nunca a encerra
  (teste AC4). A decisão "Execução viva" é a do Controle e já existia (`deps.live` / `unsettled` em `recovery.ts`); não há caminho público
  que rode a reconciliação com uma Execução viva (ela roda uma vez, na subida, antes de qualquer despacho), então essa metade não ganhou
  teste novo no Controle.
- **Cleanup de imagens.** `factory cleanup-images [<nome>] [--yes] [--json]` (`src/entrypoints/image-cleanup.ts`, rodado pelo próprio CLI
  como o `doctor`; `cleanupLambdaImages` / `planImageCleanup` em `src/sandbox/lambda/image-cleanup.ts`). Em uso = `image.json` de algum
  ambiente de Trabalho a registra, ou MicroVM não encerrada roda dela, ou está `CREATING`. Sem `--yes` só planeja; pelo nome, imagem em
  uso é recusada com `IMAGE_IN_USE` (saída 1). Apaga versão, imagem, artefato de build e log group (`deleteBuildArtifact`,
  `deleteBuildLog`, operações novas da porta). **Mudança no Remover:** `removeLambdaEnvironment` agora apaga o `image.json` do ambiente
  (o Trabalho deixa de deter a imagem; a imagem em si fica). Foi isso que o ticket 03 previu; o 06 tinha deixado o registro.
- **Fake da conta em arquivo.** `lambdaAccountFake({ stateFile })`: o estado é lido na criação e gravado (troca atômica) depois de cada
  operação; o processo morto deixa a conta como a última operação deixou. Sem caminho fixo. `listsMicrovmTags` (default `false`, a forma
  observada) e `plantOtherInstallation(nome)` são os outros acréscimos.
- **Política:** nenhuma ação nova. `lambda:ListMicrovms`, `s3:DeleteObject` e `logs:DeleteLogGroup` já estavam em `operationPolicy` e no
  template. `tag:GetResources` NÃO foi adicionado: a API de tagging é eventualmente consistente, o ARN de MicroVM não é documentado e o
  inventário não precisa dela.
- **Arquitetura:** `image-cleanup` entrou na classificação de entrypoints do CLI em `.dependency-cruiser.cjs` (mesmas regras do `doctor`).
- **Documentação:** `docs/lambda-installation.md` seções 7 (tags, evidência = `GetMicrovm`, Run/Terminate fora do CloudTrail por padrão,
  reconciliação) e 8 (cleanup de imagens).

Testes: `test/entrypoints/lambda-crash-reconciliation.test.ts` (o cenário real: filho com a composição de produção, SIGKILL com o Builder
em curso, novo dono no mesmo armazenamento e conta; entrada `slow` em `test/tiers.json`; fixture e filho em `lambda-crash-fixture.ts` e
`lambda-crash-child.ts`), `test/sandbox/lambda-reconciliation.test.ts` (variações e regra pura), `test/sandbox/lambda-image-cleanup.test.ts`,
`test/entrypoints/image-cleanup-cli.test.ts`, casos em `lambda-cli-service.test.ts`. Não foi red-green estrito: o inventário foi escrito
junto dos testes (sensibilidade conferida por mutação no filtro de instalação); o cleanup de imagens teve os testes antes.

Formas não provadas, cada uma isolada:

- **Tags de MicroVM** (herdado do ticket 04): se o `RunMicrovm` aceita `--tags` e se o `ListMicrovms` as mostra (`listedMicrovms` em
  `cli-service.ts` lê `tags` se vierem). Sem elas o inventário decide pela imagem e a MicroVM sem registro sai sem Trabalho atribuído.
- **Paginação do `ListMicrovms`** (50 por página; o CLI segue as páginas, nunca exercitado) e **consistência da listagem** logo depois
  de um `RunMicrovm`: uma MicroVM criada instantes antes do crash e ainda ausente da listagem não é vista, e o início sem resposta seria
  fechado mesmo assim. Ela só seria achada no inventário seguinte ou encerrada pelo serviço na duração máxima do boot.
- **`s3api delete-object` e `logs delete-log-group`** com a role de operação (as provas limparam com identidade administrativa).

Pendências e limites:

- **Nada foi executado em conta real** (sem autorização do Operador); os critérios estão marcados pelo que o fake prova.
- MicroVM da instalação cujo Trabalho o armazenamento não conhece (registro de boot existe, Controle não tem o Trabalho) NÃO é encerrada:
  vira `UNKNOWN_RESOURCE` e fecha o despacho, como qualquer recurso de dono desconhecido no MVP. Não há comando para encerrá-la.
- O inventário roda só na subida do controlador; não há varredura periódica.
- Visto no cenário de SIGKILL (não é do Lambda, é do MVP): o processo morto pode deixar um diretório transitório `run/github-*` de uma
  chamada GitHub em curso, que o inventário do host reporta como `UNKNOWN_RESOURCE` e mantém o despacho fechado. O cenário confere só a
  parte da conta (`lambda/...`) por isso.
- `cleanup-images` roda sem lock ao lado do controlador: um Preparar que passe a usar a imagem entre o plano e a remoção não é excluído.
- A coleta de evidência no Parar de um boot órfão usa o canal com a chave de sessão ainda no host; se falhar, a evidência fica `lost`.
- O `owner.ts` continua exigindo os guest assets da release numa instalação Lambda (nota do ticket 06), e o texto das seções 1 e 6 de
  `docs/lambda-installation.md` ainda diz que o controlador não executa Trabalhos no adapter (desatualizado desde o 06; não mexi).

O que os tickets seguintes precisam saber:

- **10/12:** um boot encerrado pela reconciliação termina com `end.reason: 'end'` e `stop.detail` "controller recovery: ...", não `loss`.
  Quem alterar `removeLambdaEnvironment` deve manter a remoção do `image.json`.
- **14:** `lambda/reconciliations/*.json` traz `startedAt`/`terminatedAt` das MicroVMs que nenhum registro de boot detinha: consumo
  que não aparece em nenhum `boot.json`.
- **16:** validar em conta real as três formas não provadas acima.

`npm run test:ci` (2026-11-21, depois do merge da ponta de `integration/software-factory-v2-lambda` com os tickets 07 e 10): 2038 testes,
2016 passam, 17 pulados, 5 falham, resultado FAIL. As 5 falhas são as conhecidas da base: `test/sandbox/audited-vfs-guard.test.ts` (4) e
`test/sandbox/sandbox-adapter-diagnostics.test.ts` (1).

## Comments

**2026-11-21 — Passe de correções da revisão final (branch `implement/v2-lambda-review-fixes`).**
- **Itens 10, 18 e 26 da revisão:** o boot de uma Execução interrompida por queda do controlador, sem disco persistente e com Builder
  ativado, é parado com motivo `loss` (antes `end`) e a perda é gravada na reconciliação (`cause: not-inspected`), com entrada no
  ledger de boots. `reconcileBoot` recebe `access` para as leituras do `origin`. O teste de crash confere isso.
- **Standards 3:** `test/entrypoints/lambda-crash-reconciliation.test.ts` usa `ended()` (filho `detached`) e o filho usa `untilHolds()`
  do orçamento do runner; não há mais espera sem limite.
- Seções 1 e 6 de `docs/lambda-installation.md` e `docs/local-installation.md` não dizem mais que o controlador recusa Trabalhos no
  adapter (item 9, standards 2). `SANDBOX_ADAPTER_UNAVAILABLE` saiu dos tipos de recusa da seleção e da composição (standards 5); só a
  guarda do ciclo Gondolin o emite.
