# Software Factory v2 — ambientes reconstruíveis em Lambda MicroVMs

Status: resolved
Label: wayfinder:map

## Destination

Definir e validar a arquitetura da Software Factory v2 para um novo tipo de sandbox: ambientes
reconstruíveis em AWS Lambda MicroVMs, preservando a continuidade do Trabalho e a autoridade do
controlador. O harness continua sendo o do MVP; harnesses substituíveis ficam para a v3.
Sem prometer suporte por pesquisa documental nem homologação antes da prova.

## Notes

- Reescopo decidido pelo Operador em 2026-11-20: a v2 trata somente do sandbox Lambda MicroVMs.
  A trilha de harnesses substituíveis (Pi/Claude Code) saiu deste mapa e fica para a v3; seus
  tickets resolvidos permanecem como registro e evidência, listados em Out of scope.
- O [PRD](../software-factory/prd.md), a [spec](../software-factory/spec.md) e os tickets do MVP
  permanecem intactos. As direções aprovadas vivem nos respectivos Answers; ampliar este mapa não
  reinterpreta a decisão de Lambda como aprovação prévia de Claude ou de uma interface nova.
- Preservar os limites da trilha AWS: gerenciados/serverless, sem EC2 própria como etapa prévia;
  instalação de um Operador na própria conta, sem SaaS, multi-tenant ou HA. Não comparar provedores
  genericamente nem adicionar seleção automática, Slots por adapter ou política híbrida por suposição.
- Usar o vocabulário do PRD. Boot é uma ativação do ambiente, não um novo Trabalho. Harness e sandbox
  são escolhas distintas; continuidade do Trabalho não exige conservar sessão nativa ou disco.
  Não criar glossário global nem promover propostas superadas a conceitos do domínio.
- Seguir o [tracker local](../../docs/agents/issue-tracker.md): tipos/labels `wayfinder:*`,
  dependências numéricas, `Status: claimed` antes do trabalho e `## Answer` ao resolver. Resolução
  canônica fica no ticket; o mapa recebe sínteses. Consultar filhos abertos, desbloqueados e não
  reivindicados em ordem numérica; a estrutura abaixo não duplica uma lista de status abertos.
- Antes de fechar o mapa, resolver lacunas de composição e rastrear requisitos, contratos e aceite
  integrado. Distinguir aprovação documental, evidência dos protótipos e homologação de produção.
  Prova necessária ainda ausente exige filho explícito, não suposição na spec.
- Proveniência do registro inicial: branch `docs/software-factory-v2-lambda`, worktree
  `.worktrees/software-factory-v2-lambda/`, integração local em main sem push.
- Registro desta ampliação: branch `docs/v2-unified-map`, worktree `.worktrees/v2-unified-map/`;
  destino main no checkout principal, integração local fast-forward e limpeza, sem push.
- Esta ampliação só registra planejamento. Não executa provas, modelos, login ou uso de credenciais,
  não instala serviços nem provisiona recursos. Cada experimento exige confirmação específica de
  ambiente/conta, permissões, limites de consumo/prazo/custo e cleanup no seu ticket.

## Work structure

As dependências canônicas são os campos `Blocked by:` dos tickets.

- [direção Lambda](issues/01-lambda-microvms-direction.md#answer) →
  [prova Docker e transporte](issues/02-lambda-microvms-prototype.md) →
  [prova de continuidade do agente entre boots](issues/09-agent-continuity-on-lambda-proof.md) →
  [consolidar PRD/spec e contratos da v2](issues/03-revised-sandbox-contract.md#answer) →
  [prova do guest Alpine](issues/10-alpine-guest-on-lambda-proof.md#answer).
  Todos os filhos estão resolvidos ou fechados; o destino é a [spec da v2](spec.md).
- Implementação e aceite: a spec foi implementada pelos tickets de `.scratch/software-factory-v2-lambda/issues/` e o
  [aceite no perfil Lambda](../software-factory-v2-lambda/issues/16-v2-acceptance-on-lambda-profile.md#answer) foi resolvido em
  2026-11-22: 31 critérios, 21 aprovados, 10 inconclusivos, nenhum reprovado, os dois obrigatórios aprovados
  ([resultados](research/lambda-acceptance-results.md)). Os achados em aberto seguem nos tickets 17 a 26 da mesma pasta.

## Decisions so far

- [Definir a direção da v2 para Lambda MicroVMs](issues/01-lambda-microvms-direction.md#answer):
  contrato por propriedades/capacidades, preservação Git remoto antes das esperas humanas,
  reconstrução entre boots e transporte SSH/WebSocket como hipótese; sem alteração do MVP nem
  homologação de Docker ou transporte.
- [Validar Docker e transporte em Lambda MicroVMs](issues/02-lambda-microvms-prototype.md#answer):
  Docker (com Compose e Testcontainers), SSH sobre WebSocket pelo `HTTP_INGRESS` e reconstrução pelo Git
  remoto funcionam no perfil testado, sem harness; canal fechado não encerra processo, egress sem
  filtro e limites de quota/disco ficam para a consolidação. Recursos retidos para a prova seguinte.
- [Validar a continuidade do agente entre boots em Lambda MicroVMs](issues/09-agent-continuity-on-lambda-proof.md#answer):
  com o Pi do MVP no host, a troca planejada funciona com a mesma sessão sobre o ambiente reconstruído e o
  efeito ambíguo não é repetido; após perda, a sessão substituta não presume o que sumiu mas não concluiu a
  fase, e a ativação segue viva depois da morte do ambiente. Uma campanha; recursos das duas provas removidos.

- [Consolidar o PRD e a spec da v2 para o sandbox Lambda MicroVMs](issues/03-revised-sandbox-contract.md#answer):
  [spec da v2](spec.md) aprovada como diferenças frente ao MVP: adapter por instalação com capacidades
  declaradas, gate Git antes de toda espera, troca e perda com limites, relaxamento de rede aprovado e
  matriz de aceite; guest Alpine fica para prova própria e a implementação sai deste mapa.

- [Validar o guest Alpine com o ambiente declarado em Lambda MicroVMs](issues/10-alpine-guest-on-lambda-proof.md#answer):
  imagem a partir de Alpine pelo `Dockerfile` fixo da declaração funciona em ARM64, com `apk` exato, Docker,
  SSH, pull por digest, Compose e Testcontainers sobre musl; a causa de falha de build só está no log de
  build. Reuso por chave e x86 não provados; recursos removidos.

## Not yet specified

Nada: a prova do guest Alpine passou e a forma da declaração de ambiente não precisou voltar ao Operador.

## Out of scope

- Alterar retroativamente o PRD/spec e as decisões aprovadas do MVP.
- Implementar adapters de produção ou executar provas a partir desta aprovação de planejamento.
  A implementação do adapter Lambda é esforço separado, derivado da [spec da v2](spec.md).
- Suspend/resume, VPC, escolha de sandbox por repositório e teto de custo em dólares: fora da v2 pela
  [consolidação](issues/03-revised-sandbox-contract.md#answer).
- Compartilhar/intermediar assinatura, extrair tokens, contornar quotas ou fallback pago silencioso.
- Comando de troca em operação, migração universal de transcripts, framework genérico de plugins,
  roteamento automático ou promessa de qualquer combinação harness/sandbox.
- Prometer Docker, restauração de RAM, snapshots transferíveis ou SSH funcional antes das provas.
- Adotar S3/git bundle como checkpoint inicial, serviço exec próprio ou outro motor por suposição.
- Publicar branches, GitHub Issues, PRs ou recursos externos automaticamente.
- Harnesses substituíveis (Pi/Claude Code, seleção por papel, assinatura do Operador, sessão
  substituta entre harnesses): fora da v2 por decisão do Operador em 2026-11-20; ficam para a v3,
  como esforço novo. Tickets já resolvidos nessa trilha, preservados como evidência:
  [direção de harnesses](issues/04-substitutable-harnesses-direction.md#answer),
  [interface de execução](issues/05-execution-seam-research.md#answer),
  [spec da prova](issues/06-harness-proof-spec.md#answer) e
  [prova Pi/Claude](issues/07-harness-compatibility-prototype.md#answer) (aceite local C1–C12,
  com ressalva; sem homologação de produção ou Lambda).
- [Decidir a composição de harnesses e sandboxes da v2](issues/08-runtime-sandbox-composition-decision.md):
  fechado sem resolução; a pergunta só existe com mais de um harness.
