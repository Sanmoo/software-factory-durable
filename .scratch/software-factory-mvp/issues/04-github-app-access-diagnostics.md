# 04: Diagnosticar o acesso GitHub pela identidade da Factory

**What to build:** O operador diagnostica acesso real pela GitHub App configurada e entende quais operações/repositórios estão acessíveis, sem usar identidade pessoal nem confundir acesso operacional com certificação das barreiras de merge do time.

**Blocked by:** [02: Operar um controlador exclusivo com pausa durável](02-exclusive-controller-and-durable-pause.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Doctor autenticado passa pelo controlador e verifica identidade da App/instalação, repo/base, permissões operacionais e escolha explícita de Workflows; leitura negada, incompatibilidade e consulta parcial têm causa/ação.
- [ ] Emissor e chave protegida ficam somente no controlador; concessões reduzem explicitamente repo, papel e finalidade, conferindo escopo devolvido e persistindo apenas metadados.
- [ ] gh api usa executável/argumentos estruturados, host e versão REST explícitos, ambiente privado e GH_TOKEN fora de argv; sem shell/pipeline, login pessoal, aliases ou fallback de identidade.
- [ ] Payload, identidades, status/headers e completude são validados; página posterior falha não transforma saída parcial em sucesso, e rate limit informa espera/escopo afetado.
- [ ] Segredos conhecidos são registrados em memória para filtragem antes do uso e não aparecem em logs, diagnóstico, sessão ou estado; testes de vazamento usam valores sintéticos.
- [ ] Tracker e CodeRepository conservam contratos distintos com infraestrutura GitHub privada compartilhável; nenhum adapter importa/consulta o outro para decidir domínio.
- [ ] Diagnóstico não altera GitHub, certifica/monitora bypass/base/CI ou exige provas negativas dessas barreiras; essas responsabilidades permanecem do time.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 2.3, 8, 8.1, 11.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-03, V-05, V-16 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
