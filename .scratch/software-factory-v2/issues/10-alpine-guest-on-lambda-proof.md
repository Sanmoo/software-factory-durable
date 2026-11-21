# Validar o guest Alpine com o ambiente declarado em Lambda MicroVMs

Status: resolved
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

## Answer

Aceito pelo Operador em 2026-11-21. Detalhe e evidência no [relatório](../research/alpine-guest-results.md),
com [avaliação por critério](../research/alpine-guest-assessment.json) sobre a
[rubrica v1](../research/alpine-guest-rubric.json).

**Sim, no perfil testado.** Em `us-east-1`, ARM64, com o container da aplicação em Alpine 3.23.8 sobre a
base gerenciada `al2023-1`, os dez critérios foram aprovados:

- **Build.** O `Dockerfile` fixo, montado só com os pares `nome=versão` da declaração validada, gera a
  imagem em cerca de 2 min. Versão inexistente faz o build falhar, sem imagem utilizável nem outra versão.
- **Boot.** `dockerd` e `sshd` nascem no hook de início, não no snapshot. SSH utilizável em 7 s; Docker
  pronto entre 6 s e 19 s depois.
- **Ambiente.** Pacotes `apk` nas versões exatas, pull por digest no boot, Compose, e Testcontainers com
  Ryuk e PostgreSQL sobre o JDK musl.

**O que a implementação herda:** a causa da falha de build só aparece no log de build, não na API; os
pacotes do molde precisam de versão fixada no pin da release; o storage driver é `overlayfs`; digest
inexistente aparece como `401` do registro; cada pedido de build gera dois registros, um por geração de
chip, com efeito na cobrança não medido.

**Não provado aqui:** reuso de imagem por chave, x86_64, papéis e reconexão sobre Alpine, repositório
real. Não é aceite da fábrica nem homologação de produção.

**Custo e recursos.** 2 pedidos de build, 2 MicroVMs, cerca de 320 s; estimativa abaixo de US$ 0,10 do
teto de US$ 10. Tudo o que a prova criou foi removido e verificado. Código descartável na branch local
`prototype/v2-alpine-guest`.

## Comments

- 2026-11-20: aberto ao consolidar a spec da v2; único filho que bloqueia o fechamento do mapa.
- 2026-11-21: reivindicado; preparação da rubrica e do pedido de autorização, sem consumo de recursos.
- 2026-11-21: [plano de execução](../research/alpine-guest-execution-plan.md) e [rubrica v1](../research/alpine-guest-rubric.json) propostos; aguardam aprovação e autorização do Operador. Nada executado.
- 2026-11-21: plano autorizado e rubrica v1 aprovada pelo Operador, com os tetos propostos.
- 2026-11-21: prova executada, dez critérios aprovados, cleanup verificado; [relatório](../research/alpine-guest-results.md) aguarda o aceite do Operador. Código descartável na branch local `prototype/v2-alpine-guest`.
- 2026-11-21: resultado aceito pelo Operador; resolvido. [V2-27](../spec.md) atualizado e mapa fechado.
