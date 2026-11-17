# Prova Pi/Claude — histórico dos resultados e correções do experimento

**Estado atual:** consultar a [rodada de barreira nativa](harness-proof-terminal-summary.md),
posterior à revisão sem inferências e à rodada complementar. Aceite contratual local aprovado pelo
Operador e registrado na [resolução canônica](../issues/07-harness-compatibility-prototype.md#answer);
falhas dos runners e subteste de edição não concluído explicitamente preservados. A [síntese da campanha anterior](harness-proof-summary.md) e os
resultados abaixo são históricos e permanecem preservados.
As seções abaixo preservam a ordem dos acontecimentos; seus totais e próximos passos são históricos.
Campanha atual: 20 ativações, continuidade nativa nas duas direções observada, aceite global inconclusivo.

Ticket: [Validar Pi e Claude Code nos contratos de execução e continuidade](../issues/07-harness-compatibility-prototype.md).
Spec: [Prova local Pi/Claude](../harness-proof-spec.md).

## Estado

**Prova ainda inconclusiva. Haiku Builder completou a tarefa real; Standards e Spec rodaram, mas receberam texto vazio por erro no bridge de captura/paginação. Sete ativações acumuladas, 13 remanescentes. Nenhuma compatibilidade integral aprovada.**
Ticket permanece claimed. Não resolver um segundo ticket nesta sessão.

## Perfil e exceções autorizadas

Referência MVP imutável `aabe06abfb20e83593020c0fee19b078d235466b`, copiada sem edição de fonte.
Runner descartável Claude J1: `.scratch/software-factory-v2/prototype/claude-j1.mjs`, registrado
no commit `29f1af5` (prefixo; branch local `prototype/v2-harness-proof`). O caminho pertence à branch
da prova, não a main; consultar a [proveniência da integração documental](harness-proof-documentary-integration.md).
SHA256 do runner no manifesto pré-execução:
`e77f30fd055acf27255c6f3929e5c4a0a23dfd63f1237fe93a793c50fbcb5e2c`.

- Node 24.21.0; Claude Code oficial 2.1.325; Agent SDK 0.3.325.
- Claude solicitado: Haiku, resolvido sem inferência no handshake para `claude-haiku-5-5`, esforço low.
- Pi previsto: OpenAI gpt-6-luna por assinatura/OAuth, não executado.
- Gondolin 0.14.0 e Pi 1.5.2 com os perfis staged do snapshot, verificados por seus hashes.
- Exceção aprovada: Claude usa autenticação pessoal existente exclusivamente pelo fluxo nativo,
  sem copiar tokens. Status sanitizado confirma claude.ai/firstParty/Max. Ambiente exclui API key;
  configuração user/project/local, connectors e memória automática desabilitados nos mecanismos SDK.
  Configuração global sempre lida pelo CLI continua limitação explícita, não perfil dedicado completo.
  Não fazer logout, remover perfil pessoal ou alterar intencionalmente suas configurações no cleanup.

## Primeira tentativa — execução e observações

Comando:

`node .scratch/software-factory-v2/prototype/claude-j1.mjs --execute`

1. Preflight/build/typecheck do snapshot passaram após o preparo staged correto, sem alteração de fonte.
2. Sandbox público preparou um ambiente descartável próprio, disco virtual 4 GiB (cerca de 626 MB
   alocados), 1 vCPU e 1024 MiB. Assets existentes usados somente para leitura com pin
   `8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807`.
3. `Sandbox.start` recusou boot com **SANDBOX_RUNTIME_PATH_TOO_LONG**, antes de criar boot/VM.
4. Runner encerrou sem tentar modelos e sem repetição automática. `Sandbox.observe` retornou
   `condition: not-booted`, `cessationConfirmed: true`, `boot: null`.

Diagnóstico confirmado por leitura: runtime de sockets deriva do root em
`workerRuntimeDirectory`, no snapshot; `bootRuntimePaths` recusa qualquer socket Unix com mais de
107 bytes. O root dentro da worktree, mais os componentes de sessão, excede o limite.
Não é falha do Claude ou Pi, nem motivo para alterar o MVP ou desabilitar a guarda.

## Primeira tentativa — critérios e consumo

C1–C12: **inconclusivos**, nenhum foi exercitado. Zero ativações de modelo; não se atribui
resultado de jornada ao handshake sem prompt. Nenhuma cobrança API foi usada. Processamento remoto
em background do fornecedor não foi consultado; o ensaio não enviou prompt ou tool a modelo.
A tentativa de bootstrap inaugura o registro de execução local, mas não consome ativações de modelo;
qualquer repetição deve respeitar a janela/autorização da campanha ou renová-la explicitamente.

## Primeira tentativa — cleanup e recursos preservados

- Nenhum boot/VM criado; cessação confirmada pelo Sandbox público.
- Nenhum worker Claude de inferência foi lançado. Auditoria SDK anterior fechou seu processo sem prompt.
- Perfil pessoal Claude preservado, sem logout ou cópia de credenciais.
- Cópia do snapshot, dependências e ambiente preparado mantidos em `.runtime/` na worktree própria
  para diagnóstico/retomada. Não são recursos de outra frente. Manifesto e resultado bruto sanitizado
  estão nesse diretório ignorado; este relatório retém os fatos relevantes.
- Branch/worktree preservadas: `prototype/v2-harness-proof`, `.worktrees/harness-proof-run/`.
  Não integrar código descartável em main nem declarar cleanup completo enquanto esses recursos existirem.

## Segunda tentativa — runtime curto autorizado, quota indisponível

O Operador autorizou explicitamente `/home/sanmoo/sfhp-v2` e uma nova tentativa de bootstrap.
Runner commit `d56590c`, SHA256
`a6356dd78ccafc5188787b27efee262f5202d5fb6cdffa0c07b5a65d16cc5b56`.
[Eventos e diagnóstico sanitizados](harness-proof-attempt-2.json).

- Início: `2026-11-16T00:03:33.397Z`; fim: `2026-11-16T00:04:37.213Z`.
- VM real iniciou. Comandos de preparação da fixture rodaram no guest por Sandbox público.
- Uma ativação Builder tentada. Inventário efetivo: somente `mcp__factory__bash`, servidor factory
  conectado com source sdk, modelo `claude-haiku-5-5`, permissionMode default, apiKeySource none.
  Não havia Bash/Edit/Read host nem ferramenta de delegação no inventário observado.
- CLI produziu assistant de modelo `<synthetic>`, `isApiErrorMessage: true`, erro **rate_limit**:
  limite de cinco horas atingido. A dica nativa de reset foi 21:30 America/Fortaleza; não é garantia
  de quota futura e não foi usada para agendar repetição.
- O runner antigo chamou isso de MODEL_DRIFT, por comparar o modelo sintético com Haiku antes de
  tratar erros. A evidência original não foi reescrita. Diagnóstico corrigido: quota indisponível,
  não fallback nem incompatibilidade de modelo. Classificador descartável corrigido e testado sem
  modelos: quatro casos passaram (quota sintética, modelo real divergente, Haiku normal, sintético
  sem erro explicativo). Não foi feita nova chamada real após a correção.
- Aviso SDK CAN_USE_TOOL_SHADOWED observado: allow explícito de factory bash antecede canUseTool.
  Isso é previsto pela pesquisa, não uma barreira adicional. Confinamento continua no backend e
  superfície disponível; não alegar que o callback foi exercitado ou protegeu essa chamada.
- Nenhum revisor ou retorno ao Builder foi executado. C1–C12 continuam inconclusivos. Uma ativação
  tentada deve ser debitada do limite autorizado (restam no máximo 19, não uma campanha renovada).
  Métricas zero da mensagem sintética não comprovam saldo/consumo completo do fornecedor.
- Processo Claude próprio terminou com exit code 1. Sandbox.stop e observe confirmaram cessação;
  observação stopped. `termination: unconfirmed` e `guestFinalization: observed` são detalhes do
  stop: não confundir finalização com propriedade mais ampla que o oráculo efetivamente demonstra.
- Após preservar evidência, Sandbox.remove confirmou remoção de disk, workspace, artifacts e runtime;
  observe retornou removed/cessationConfirmed true, disco/workspace/artifacts ausentes.

O código do classificador posterior não foi usado para alterar o resultado original nem autoriza
nova tentativa. Não houve API paga, mudança de harness/modelo ou repetição para contornar quota.
O snapshot e dependências descartáveis continuam disponíveis; metadados de cleanup do root curto
são preservados. A sessão nativa própria da tentativa permanece no perfil pessoal para inspeção,
sem logout ou remoção do perfil. Cleanup final desses registros permanece explícito, sem tocar
sessões de outras frentes. Ticket segue claimed, branch/worktree preservadas.

## Terceira tentativa — retomada autorizada e lacuna da fixture

Operador pediu retomar após a quota possivelmente ter sido restabelecida. Uma chamada mínima
Haiku sem tools/VM confirmou disponibilidade por subscription: resposta OK, apiKeySource none,
processo encerrado. Essa chamada conta como ativação. Runner da consulta: commit `5af7ca4`.

Em seguida, J1 usou novo ambiente descartável no root curto, mesmo snapshot, perfis, pin e limites,
sem readmitir o ambiente previamente removido. Runner pré-execução: commit `c7a5afb`, SHA256
`2e4d75919cd5d4310d94d0026fcddcd1a37b7a4343ed660aa03040eccf8aa4cf`.
[Evidência sanitizada da retomada](harness-proof-attempt-3.json).

- Uma ativação adicional de Builder, quatro turnos de modelo observados, todos Haiku 5.5.
  Modelo corrigiu add.mjs para `a+b` usando o MCP bash e executou teste no guest.
  Captura protegida contém os resultados `5 0` e `PASS`; arquivo final confere com a correção.
- Fixture era somente um diretório com arquivos, não um repositório Git. Consultas normais
  `git diff`/`git status` feitas pelo modelo falharam, embora a alteração/teste já tivessem ocorrido.
  O wrapper descartável transformou exit não zero em erro sem devolver a saída útil, contribuindo
  para tentativas de diagnóstico. A ativação atingiu maxTurns 4 antes da resposta final.
- Execução afetada foi encerrada sem aumentar turnos, repetir Builder ou avançar a revisores.
  Isso não prova incompatibilidade do harness. C1 tem evidência parcial (Builder/ferramenta/tarefa),
  mas falta a obrigação dos três papéis; C1–C12 continuam sem aprovação integral.
- Preparação do runner corrigida para criar e comitar baseline Git da fixture antes de entregar
  a tarefa. Essa correção não foi executada com modelos; próximo manifesto deve refletir seus bytes.
- Consumo observado na ativação Builder, deduplicado por message id: input 8, output 481,
  cache-read 5007 e cache-creation 2069 tokens. Consulta mínima adicional: input 2, output 4,
  cache-creation 911. Não são saldo da assinatura nem fatura ou garantia de observação completa.
  Custo estimado do SDK na consulta não é cobrança API. Não houve autenticação API/fallback.
- Total acumulado: 3 ativações tentadas (recusa de quota + consulta + Builder), restam no máximo 17.
- Processo Claude e VM cessaram; após preservação da evidência, Sandbox.remove confirmou remoção
  de disk/workspace/artifacts/runtime. Observe retornou removed/cessationConfirmed true.
  Perfil pessoal e sessões alheias não foram removidos. Metadados e dependências próprias preservados.

## Quarta tentativa — três papéis reais, leitura de revisão inválida

O Operador autorizou repetir J1 com a fixture Git corrigida. Primeiro bootstrap parou antes de modelos
por safe.directory: perfil do guest confia em `/workspace/*`, não no próprio `/workspace`.
[Registro do bootstrap sem modelo](harness-proof-fixture-bootstrap.json). Recursos removidos após
cessação. Correção somente na fixture: repositório sob `/workspace/checkout`, sem ampliar a política.

Novo preparo dentro da mesma autorização, sem repetição de inferência, permitiu completar quatro
ativações. Runner commit `65ca98e`, hash
`7d1e7071546ce3c775fcd03de7a9dc893d3b4697b4aac439d92c96bccee3c521`.
[Evidências e pareceres da tentativa](harness-proof-attempt-4.json).

- Builder Haiku concluiu a correção e o teste, três turnos; verificador independente no guest
  registrou FIXTURE_PASS. Houve leitura/escrita/execução reais via MCP e Sandbox, sem tool host.
- Standards e Spec reais, três turnos cada, receberam somente MCP read, mas responderam FAIL
  porque lhes foi entregue texto vazio. Essas são falhas de acesso à evidência, não pareceres válidos
  sobre a alteração. SDK success/exit 0 não aprova C1/C2.
- Bridge descartável usava apenas capture.data, que é vazio por contrato: capture fornece recibo
  e referência; conteúdo deve vir de read/page. Pesquisa/código do SHA fixado confirmam essa ordem.
  Defeito do protótipo, não incapacidade de Claude nem bug a corrigir no Sandbox/MVP.
- Builder substituto recebeu os dois pareceres e constatou que os arquivos tinham conteúdo.
  Isso comprova entrega explícita e reação, não revisão válida nem retomada de sessão nativa.
- Probes determinísticos no backend recusaram escrita, Bash e traversal por revisor. Faltam outros
  componentes de C4 e C5. Builder anterior foi encerrado antes dos revisores, sem alegar prova
  universal de ausência de pedidos remotos/background. Revisores foram sequenciais neste ensaio.
- Correção no bridge percorre páginas protegidas, valida referência/progresso/tamanho e impede
  tratar falha parcial como arquivo vazio. Oito testes determinísticos do protótipo passaram.
  Acrescentado smoke de leitura real antes de qualquer modelo no próximo runner.
- Tentativa de verificar a correção sem modelos em novo boot do mesmo ambiente retornou
  BOOT_ENDED_BEFORE_OPERATIONAL_CONFIRMATION / vm-start:GUEST_READINESS_TIMEOUT.
  Não qualificar a correção como provada em VM. Zero novas ativações nesse check; cessação
  confirmada, sem repetir bootstrap. Esse timeout local não é evidência sobre Claude.
- Modelo/perfil/auth mantidos Haiku 5.5, subscription, apiKeySource none. As quatro ativações
  completaram em três turnos cada; total da campanha agora 7, restam 13, sem reset de consumo.
  Estimativas list-price retornadas pelo SDK não são fatura nem cobrança API.
- Após preservação de evidência, ambos os boots foram reconciliados como cessados e Sandbox.remove
  confirmou disk/workspace/artifacts/runtime removidos; observe removed/cessationConfirmed true.
  Metadados, dependências e registros próprios preservados; nenhum logout do perfil pessoal.

C1 tem Builder aprovado como subcritério, mas falta revisão válida para aprovar o critério inteiro.
C2/C3/C4 têm observações parciais, sem aprovação integral. C5–C12 ainda sem prova suficiente.
Não tratar término do roteiro J1 com exit 0 como aprovação da jornada ou da integração.

## Próximo passo

Antes de nova inferência, comprovar o smoke de captura/paginação em ambiente local saudável.
Somente depois refazer a revisão afetada sob autorização, manifesto e saldo de 13 ativações,
sem reset, API paga, ampliação de permissões ou declaração fictícia de J2/J3 executadas.
Nova tentativa real deve respeitar condições de parada e a janela autorizada.
