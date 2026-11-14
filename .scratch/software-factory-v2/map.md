# Software Factory v2 — sandbox AWS Lambda MicroVMs

Status: open
Label: wayfinder:map

## Destination

Avaliar um adapter AWS Lambda MicroVMs e definir a revisão pós-MVP do contrato de sandbox,
permitindo ambientes reconstruíveis e duração limitada sem exigir VFS ou disco persistente.
Chegar a um desenho sustentado por provas, não declarar o serviço homologado por pesquisa documental.

## Notes

- Esforço pós-MVP autorizado pelo operador. O [PRD](../software-factory/prd.md),
  a [spec](../software-factory/spec.md) e os tickets de implementação do MVP permanecem intactos.
- Preferir serviços gerenciados/serverless da AWS; não usar EC2 própria como etapa prévia.
  A investigação atual concentra-se em Lambda MicroVMs, não numa comparação geral de provedores.
- Instalação de um operador na própria conta AWS; sem SaaS, multi-tenant ou HA.
- Usar o vocabulário do PRD. Boot identifica uma ativação concreta do ambiente, não um novo Trabalho.
  Não criar glossário global ou promover propostas superadas a conceitos do domínio.
- Seguir o [tracker local](../../docs/agents/issue-tracker.md): tipos/labels `wayfinder:*`,
  dependências numéricas, `Status: claimed` antes de trabalhar e `## Answer` ao resolver.
  Aprovação de desenho não comprova viabilidade técnica.
- A resolução de cada decisão vive no Answer do respectivo ticket; este mapa recebe somente sínteses.
  Consultar os filhos abertos, desbloqueados e não reivindicados em ordem numérica.
- Registro desta sessão: branch `docs/software-factory-v2-lambda`, worktree
  `.worktrees/software-factory-v2-lambda/`; destino `main` no checkout principal deste repositório.
  Integração local fast-forward e limpeza autorizadas; sem push.
- Nenhum recurso AWS foi provisionado neste registro. O protótipo tem concordância em princípio,
  mas exige confirmação específica de conta, região, permissões, orçamento e cleanup antes de executar.

## Decisions so far

- [Definir a direção da v2 para Lambda MicroVMs](issues/01-lambda-microvms-direction.md):
  contrato por propriedades/capacidades, preservação via Git remoto antes das esperas humanas,
  reconstrução entre boots e transporte SSH/WebSocket como primeira hipótese a provar;
  sem alteração do MVP nem homologação de Docker ou do transporte.

## Not yet specified

As provas e a revisão implementável são os próximos passos, não decisões resolvidas por este mapa:

- Compatibilidade real de Docker, Compose, Testcontainers/Ryuk, DNS, binds e portas.
- Viabilidade e custo operacional de SSH sobre WebSocket no ingresso de produção da Lambda.
- Limites atuais do serviço, evidência de cessação e proteção de rede/credenciais.
- Detalhamento do gate Git, reconstrução, rotação de boot e compatibilidade de sessão.
- Interface/configuração revisadas, impacto nos contratos existentes e matriz de aceite da v2.

## Out of scope

- Implementar o adapter ou revisar agora o PRD/spec aprovado do MVP.
- Provisionar AWS, instalar serviços no host ou executar o protótipo sem a confirmação específica.
- Prometer suporte a Docker, restauração de RAM, snapshots transferíveis ou SSH funcional antes da prova.
- Adotar S3/git bundle como checkpoint inicial, serviço exec próprio ou outro motor de controle por suposição.
- Definir seleção automática de adapter, Slots por adapter ou política híbrida sem decisão posterior.
- Publicar branches, GitHub Issues, PRs ou recursos externos automaticamente.
