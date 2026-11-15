# Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis

Status: open
Label: wayfinder:map

## Destination

Definir e validar a arquitetura da Software Factory v2 para ambientes reconstruíveis e harnesses
substituíveis, preservando a continuidade do Trabalho e a autoridade do controlador. Investigar AWS
Lambda MicroVMs como sandbox e Pi/Claude Code como harnesses concretos, incluindo assinatura própria
do Operador, sem prometer combinações universais nem homologação por pesquisa documental.

## Notes

- Um único mapa coordena as duas trilhas e sua convergência. Pesquisas/provas independentes podem
  avançar em paralelo; contratos compartilhados precisam de decisão e especificação integradas.
  A investigação de harness não espera a prova Lambda, mas não homologa a composição com ela.
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

As dependências canônicas são os campos `Blocked by:` dos tickets. A convergência não transforma
as trilhas em sequência única nem permite aprovar contratos de composição independentemente.

- **Sandbox:** [direção Lambda](issues/01-lambda-microvms-direction.md#answer) →
  [prova Docker e transporte](issues/02-lambda-microvms-prototype.md).
- **Harness:** [direção de substituição](issues/04-substitutable-harnesses-direction.md#answer) →
  [investigar interface existente](issues/05-execution-seam-research.md) →
  [especificar a prova](issues/06-harness-proof-spec.md) →
  [prova Pi/Claude](issues/07-harness-compatibility-prototype.md).
- **Convergência:** ambas as provas →
  [decidir a composição](issues/08-runtime-sandbox-composition-decision.md) →
  [consolidar PRD/spec e contratos da v2](issues/03-revised-sandbox-contract.md).
  Evidências cruzadas adicionais e implementação/validação integrada futura devem ganhar filhos
  quando o escopo necessário estiver definido, sem inventar uma implementação já autorizada.

## Decisions so far

- [Definir a direção da v2 para Lambda MicroVMs](issues/01-lambda-microvms-direction.md#answer):
  contrato por propriedades/capacidades, preservação Git remoto antes das esperas humanas,
  reconstrução entre boots e transporte SSH/WebSocket como hipótese; sem alteração do MVP nem
  homologação de Docker ou transporte.
- [Definir a direção da v2 para harnesses substituíveis](issues/04-substitutable-harnesses-direction.md#answer):
  Pi/Claude com seleção por papel, assinatura própria do Operador e continuidade por sessão substituta;
  mudança por parada/configuração/reinício, sem comando de troca nem migração de transcripts.
  Provas próprias convergem neste mapa e no PRD/spec integrado, sem fallback ou execução autorizada.
- [Localizar a interface de execução e as dependências entre harness e sandbox](issues/05-execution-seam-research.md#answer):
  pesquisa no MVP `aabe06abfb20e83593020c0fee19b078d235466b`; Workers é o seam candidato, com
  hipótese Claude host + MCP confinado, sem adoção aprovada. Acoplamentos Pi, suspensão/filtragem/
  cessação e diferenças v2 de reconstrução/WIP estão rastreados; dez cenários alimentam a spec da prova.

## Not yet specified

- Compatibilidade real de Docker/Compose/Testcontainers/Ryuk, DNS, binds e portas em Lambda.
- Viabilidade de SSH/WebSocket, limites, custo e evidências de cessação/rede/credenciais do serviço.
- Validar as hipóteses de encaixe CLI/Agent SDK, ferramentas e perfil Claude localizadas pela
  pesquisa da interface, sem camada redundante; confirmar condições aplicáveis da assinatura e
  propriedades efetivas de isolamento por papel, suspensão, filtragem e cessação.
- Detalhes do gate Git, reconstrução, rotação e contexto independente de transcript; compatibilidade
  de sessão, perfis versionados e recuperação entre harnesses após reconfiguração da instalação.
- Localização de loops/ferramentas e combinações harness/sandbox suportadas; capacidades mínimas,
  diagnósticos e provas cruzadas que impeçam aprovação isolada de contratos incompatíveis.
- Configuração/instalação revisadas, custos/quotas, observabilidade/retenção, impacto nos contratos
  existentes e matriz de aceite integrada da v2.

## Out of scope

- Alterar retroativamente o PRD/spec e as decisões aprovadas do MVP.
- Implementar adapters de produção ou executar provas a partir desta aprovação de planejamento.
- Compartilhar/intermediar assinatura, extrair tokens, contornar quotas ou fallback pago silencioso.
- Comando de troca em operação, migração universal de transcripts, framework genérico de plugins,
  roteamento automático ou promessa de qualquer combinação harness/sandbox.
- Prometer Docker, restauração de RAM, snapshots transferíveis ou SSH funcional antes das provas.
- Adotar S3/git bundle como checkpoint inicial, serviço exec próprio ou outro motor por suposição.
- Publicar branches, GitHub Issues, PRs ou recursos externos automaticamente.
