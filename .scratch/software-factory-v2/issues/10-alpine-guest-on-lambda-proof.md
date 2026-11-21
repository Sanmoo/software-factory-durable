# Validar o guest Alpine com o ambiente declarado em Lambda MicroVMs

Status: claimed
Type: prototype
Label: wayfinder:prototype
Map: [Software Factory v2 — ambientes reconstruíveis em Lambda MicroVMs](../map.md)
Blocked by: 03

## Question

Uma imagem de MicroVM construída a partir de Alpine, por um `Dockerfile` fixo montado dos valores de um
`.factory/environment.yaml` (esquema v1: `apk` com versões exatas e imagens por digest), inicia em
Lambda MicroVMs com Docker, SSH e o ambiente declarado funcionando, como exige o requisito V2-27 da
[spec da v2](../spec.md)?

## Scope

- Só o que a [prova de infraestrutura](02-lambda-microvms-prototype.md#answer) não cobriu por ter usado
  Amazon Linux 2023: build da imagem a partir de Alpine, `dockerd` e `sshd` no hook de início, pacotes
  `apk` nas versões exatas, pull por digest no boot, Compose e Testcontainers com Ryuk sobre musl.
- Sem harness e sem modelo. Repositório e declaração sintéticos.
- Hipótese que falhar ou ficar inconclusiva volta ao Operador; não trocar a base ou o esquema da
  declaração por conta própria.

## Authorization gate

Consome recursos AWS. Antes de executar: rubrica aprovada e autorização específica de conta, região,
permissões, custo, prazo e cleanup, conforme os [guardrails de ensaios](../../../docs/agents/experiment-proofs.md).
Nenhuma autorização de prova anterior se estende a este ticket.

## Exit criteria

Resultado por critério aceito pelo Operador, cleanup verificado e o requisito V2-27 da spec da v2
atualizado com o que foi provado ou com a decisão que substituir a hipótese.

## Comments

- 2026-11-20: aberto ao consolidar a spec da v2; único filho que bloqueia o fechamento do mapa.
- 2026-11-21: reivindicado; preparação da rubrica e do pedido de autorização, sem consumo de recursos.
