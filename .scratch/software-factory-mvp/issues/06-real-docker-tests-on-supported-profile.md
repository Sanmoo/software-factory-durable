# 06: Executar testes Docker reais no perfil distribuível

**What to build:** Uma suíte representativa usa Docker dentro do guest suportado para executar testes de integração reais, com persistência e isolamento verificáveis, sem trocar testes ou segurança silenciosamente para obter verde.

**Blocked by:** [03: Preparar, iniciar e parar um ambiente persistente por Trabalho](03-persistent-work-environment.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Guest usa daemon/data-root próprios com driver vfs; não recebe socket Docker host, não exige Docker host para produzir assets durante instalação/Trabalho e não troca para overlay2.
- [ ] Testcontainers com Ryuk executa containers reais; conforme o escopo declarado, API/Compose/build, binds/paths, DNS, portas e volumes são exercitados e registrados.
- [ ] TLS é demonstrado nas camadas necessárias: ferramentas guest, daemon e aplicações/truststores dentro de containers; docker run/pull isolado não substitui essa evidência.
- [ ] Reboot preserva workspace, pacotes/caches e Docker data esperados sem reclone; Git/locks/renames/metadados via filesystem exposto funcionam no perfil.
- [ ] Ferramentas não alcançam host, rede privada ou outro Trabalho fora das exceções autorizadas; cleanup é próprio, sem limpeza Docker global.
- [ ] Musl, dependências nativas, certificados, portas ou nomes incompatíveis geram diagnóstico e adequação explícita, sem TLS inseguro, Ryuk desligado, testes reescritos ou fallback de sandbox.
- [ ] Prova registra manifesto/host/configuração, comandos efetivos e consumo disponível; fixture representativa não se apresenta como suíte real dos pilotos, que será demonstrada no piloto.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 7.3, 7.4, 7.5, 13.3, 14; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
