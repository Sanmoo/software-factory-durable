# Software Factory Durable

Repositório da Software Factory: proposta de transformação de tickets autorizados em PRs revisáveis,
com agentes, controle local durável, validação e merge humano.

Comece pelo [guia do MVP v2: do ticket ao merge](docs/guia-mvp-v2.md) para entender o produto, a arquitetura e o que muda com o perfil Lambda.

## Planejamento aprovado

- [PRD do MVP](.scratch/software-factory/prd.md).
- [Spec técnica aprovada](.scratch/software-factory/spec.md).
- [Mapa de decisões encerrado](.scratch/software-factory/map.md).
- [Tickets e resoluções](.scratch/software-factory/issues/).
- [Interfaces públicas e composição](.scratch/software-factory/module-public-interfaces.md).
- [Matriz de aceite e validação incremental](.scratch/software-factory/acceptance-and-incremental-plan.md).
- [Relatórios de pesquisa preservados](.scratch/software-factory/research/).

O tracker é [Markdown local](docs/agents/issue-tracker.md), com a mesma convenção do PKM de origem.
Os 26 tickets do mapa estão resolvidos; a migração preserva esse estado, não cria um backlog de implementação.

## Estado do projeto

O primeiro incremento implementa setup/doctor offline e o gate local de desenvolvimento.
O ticket 32 acrescenta a release autocontida (manifesto/integridades, Node privado, skill packs,
assets fixados), a instalação repetida/verificada e a composição de produção de execução/reviews/
credenciais. A release com os assets reais ainda não foi construída nem homologada: boot, Docker/TLS,
GitHub/modelos reais, jornada e piloto continuam provas futuras da spec e do plano de aceite.

- [Comandos de desenvolvimento e arquitetura executável](docs/development.md).
- [Preparação/configuração e diagnóstico offline](docs/local-installation.md).
- [Evidências do ticket 01 e limites de V-16](docs/evidence/01-local-setup-and-development-gate.md).
- [Release autocontida e composição de produção (ticket 32)](docs/evidence/32-self-contained-release.md).

[Proveniência, escopo e verificações da migração](docs/migrations/software-factory-from-pkm.md).
