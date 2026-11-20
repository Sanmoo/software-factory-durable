# Software Factory v2 — ambientes reconstruíveis em Lambda MicroVMs

Status: open
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
  [consolidar PRD/spec e contratos da v2](issues/03-revised-sandbox-contract.md).
  Evidências adicionais e implementação/validação futura devem ganhar filhos quando o escopo
  necessário estiver definido, sem inventar uma implementação já autorizada.

## Decisions so far

- [Definir a direção da v2 para Lambda MicroVMs](issues/01-lambda-microvms-direction.md#answer):
  contrato por propriedades/capacidades, preservação Git remoto antes das esperas humanas,
  reconstrução entre boots e transporte SSH/WebSocket como hipótese; sem alteração do MVP nem
  homologação de Docker ou transporte.
## Not yet specified

- Compatibilidade real de Docker/Compose/Testcontainers/Ryuk, DNS, binds e portas em Lambda.
- Viabilidade de SSH/WebSocket, limites, custo e evidências de cessação/rede/credenciais do serviço.
- Detalhes do gate Git, reconstrução e rotação que a consolidação precisará fixar.
- Configuração/instalação revisadas, custos/quotas, observabilidade/retenção, impacto nos contratos
  existentes e matriz de aceite da v2.

## Out of scope

- Alterar retroativamente o PRD/spec e as decisões aprovadas do MVP.
- Implementar adapters de produção ou executar provas a partir desta aprovação de planejamento.
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
