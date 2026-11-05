# 01: Preparar a instalação local e o gate de desenvolvimento

**What to build:** O operador consegue preparar a instalação e diagnosticar configuração, paths e pré-requisitos locais sem admitir Tickets nem iniciar ambientes. O desenvolvedor consegue construir e testar a aplicação com as fronteiras arquiteturais aprovadas verificadas automaticamente.

**Blocked by:** None (can start immediately).

**Status:** resolved

## Acceptance criteria

- [x] Setup repetido cria somente recursos próprios, preserva configuração/dados/credenciais existentes e começa sem repositórios autorizados; não usa sudo, instala pacotes nem altera conteúdo desconhecido.
- [x] Configuração YAML versionada é validada integralmente, com modelos por papel, operadores, repo/base e escolha de Workflows explícitos, defaults aprovados e sem valores secretos ou aplicação parcial.
- [x] Doctor offline informa versões, paths, permissões, KVM/systemd/storage e limites do socket, sem abrir o banco operacional, iniciar VM ou modificar o host; diagnóstico não é prova de Docker.
- [x] TypeScript estrito/ESM compila para Node fixado com lockfile; testes compilados usam node:test/node:assert, e npm test é a suíte local completa sem credenciais, modelos, GitHub remoto ou VM.
- [x] Analisador existente e fixado aplica a matriz de zonas, exports públicos, imports de tipos/aliases, ausência de ciclos e SDKs somente nos donos; fonte autoral não classificada falha.
- [x] Fixtures positivas/negativas comprovam import público permitido e rejeição de deep import, inversão, ciclo de tipos, alias de bypass, SDK fora da zona e fonte não classificada pelo motivo esperado.
- [x] Comandos de desenvolvimento e grupos separados de integração/agentes/pilotos são documentados; importação de módulo não inicia efeitos nem descobre perfil pessoal.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 2.2, 2.4, 11.1, 11.2, 11.3, 13.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-16 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Comments

- Implementação autorizada em 2026-11-05 na branch local `implement/software-factory-mvp-01`, worktree irmã `.worktrees/software-factory-mvp-01`, baseada em `integration/software-factory-mvp` (`2d3ffa9`). Escopo: somente setup/doctor/configuração e gate local; sem modelos, credenciais reais, remoto ou VM. Seams aprovados: CLI pública e checker arquitetural executável.

## Answer

Implementado somente o incremento local deste ticket: CLI `setup`/`doctor`, YAML
schemaVersion 1 com validação integral e defaults aprovados, factory Sandbox de
validação/pré-requisitos read-only e gate TypeScript/ESM/arquitetura/testes locais.
Não foram criados controlador/DB, workers, VMs, serviços ou comandos operacionais
simulados. Modelos/operadores/repo/base/Workflows são explícitos; `operators: []`
é permitido sem autorizar operadores remotos (confirmação do supervisor).

- [Documentação de desenvolvimento e matriz executável](../../../docs/development.md).
- [Configuração, setup e diagnóstico](../../../docs/local-installation.md).
- [Evidências V-16 do recorte, red/green, gate e riscos](../../../docs/evidence/01-local-setup-and-development-gate.md).
- Gate observado: `npm ci`, arquitetura estática real, build/typecheck e **30 testes
  locais compilados, 30 passes**, sem modelos/credenciais reais/remoto/VM; diagnósticos
  tsc/ESLint e `git diff --check` passaram. Testes ficam nos seams públicos aprovados,
  sem mocks de colaboradores internos. Checker fixado e fixtures verificam motivos/paths.
- Setup é repetível e preserva dados/config/credenciais; template inicial tem repos
  vazios e campos obrigatórios incompletos, reportados pelo doctor (não verde operacional).
- Doctor distingue configuração inválida, pré-requisito ausente e runtime não
  qualificado. KVM funcional, systemd supervisionado, durabilidade/locks e Docker/TLS
  **não foram comprovados** nem dispensados pelo diagnóstico offline.
- Risco conhecido: audit de desenvolvimento tem 5 registros moderados derivados de
  minimatch 10.2.6/GHSA-g3hv-75wg-m249, sem patch compatível disponível; detalhes e
  caminhos no relatório. `npm audit --omit=dev` retornou zero. Nenhum fix forçado.

Resolução é deste ticket, não do V-16 completo, release, demais RF/RNF/CA ou aceite
humano do MVP. Grupos reais de integração/agentes/pilotos permanecem separados e
não implementados aqui; não há scripts vazios que aleguem sucesso. A revisão
independente exigida pelo supervisor não é substituída pelo relato do implementador.
