# 01: Preparar a instalação local e o gate de desenvolvimento

**What to build:** O operador consegue preparar a instalação e diagnosticar configuração, paths e pré-requisitos locais sem admitir Tickets nem iniciar ambientes. O desenvolvedor consegue construir e testar a aplicação com as fronteiras arquiteturais aprovadas verificadas automaticamente.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Setup repetido cria somente recursos próprios, preserva configuração/dados/credenciais existentes e começa sem repositórios autorizados; não usa sudo, instala pacotes nem altera conteúdo desconhecido.
- [ ] Configuração YAML versionada é validada integralmente, com modelos por papel, operadores, repo/base e escolha de Workflows explícitos, defaults aprovados e sem valores secretos ou aplicação parcial.
- [ ] Doctor offline informa versões, paths, permissões, KVM/systemd/storage e limites do socket, sem abrir o banco operacional, iniciar VM ou modificar o host; diagnóstico não é prova de Docker.
- [ ] TypeScript estrito/ESM compila para Node fixado com lockfile; testes compilados usam node:test/node:assert, e npm test é a suíte local completa sem credenciais, modelos, GitHub remoto ou VM.
- [ ] Analisador existente e fixado aplica a matriz de zonas, exports públicos, imports de tipos/aliases, ausência de ciclos e SDKs somente nos donos; fonte autoral não classificada falha.
- [ ] Fixtures positivas/negativas comprovam import público permitido e rejeição de deep import, inversão, ciclo de tipos, alias de bypass, SDK fora da zona e fonte não classificada pelo motivo esperado.
- [ ] Comandos de desenvolvimento e grupos separados de integração/agentes/pilotos são documentados; importação de módulo não inicia efeitos nem descobre perfil pessoal.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 2.2, 2.4, 11.1, 11.2, 11.3, 13.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-16 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
