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

## Comments

- 2026-11-05 — Incremento local implementado em `implement/software-factory-mvp-04`:
  [evidência e lacunas explícitas](../../../docs/evidence/04-github-app-access-diagnostics.md).
  `checkAccess` distintos, emissor/transporte privados e `doctor --authenticated`
  pelo controlador; fixture local/sintético não comprova gh/GitHub real.
  **BLOCKED para aceite autenticado**: faltam autorização/configuração próprias
  da App/instalação/repos/base e execução real pertinente. Nenhuma credencial
  pessoal, emissão de token real, chamada/mutação GitHub ou prova de bypass foi
  usada. Critérios não marcados e ticket não resolvido.
- Correção local da revisão **F1/P1** do checkpoint `4da6ad2`: fonte REST oficial
  pública confirma `repositories: [name]` (ou `repository_ids`), não
  `repository_names`. Fixture corrigido primeiro, com instalação de dois repos,
  recusa de seletor ausente/não suportado e grant apenas para o repo explicitado;
  RED significativo (`blocked` em vez de `ok`), depois GREEN com troca mínima do
  campo no emissor. Validação do escopo devolvido preservada e coberta também para
  lista ausente/múltiplos repos. `npm run typecheck`, `npm test` (62/62, arquitetura
  e build inclusos) e `git diff --check` passaram com Node `24.21.0` no PATH.
  [Comandos, fonte, limites e resultados exatos](../../../docs/evidence/04-github-app-access-diagnostics.md#correção-local-f1p1--seletor-rest-de-repositório).
  Consulta apenas à documentação pública; sem credenciais, `gh api`, emissão real
  ou mutação remota. **BLOCKED para aceite autenticado permanece**; critérios e
  resolução inalterados.
- 2026-11-05 — Retomada autorizada com fonte privada 0600 e QEMU instalado:
  **BLOCKED agora por incompatibilidade real App JWT/gh**, não mais por falta de
  autorização/permissões locais. Controlador real + gh 2.46.0 executaram quatro
  GET `/app`, todos HTTP 401; nenhum pedido de instalação/token/repo/mutação.
  Fonte pública e probe loopback sintético do binário confirmam esquema `token`
  onde GitHub exige `Bearer` para JWT; não contornado com segredo em argv nem
  transporte novo. App/instalação, escopo, direitos e validade continuam não
  verificados, sem inferir ou ampliar permissões. Correção pré-requisito do
  flock/Btrfs em `76ff8f1` aprovada separadamente; gate final typecheck + suíte
  completa **63/63 duas vezes**. [Evidência real e lacunas](../../../docs/evidence/04-github-app-access-diagnostics.md#ensaio-real-autorizado-de-2026-11-05--blocked-em-app-jwt--gh).
  Critérios não marcados; ticket não resolvido. Decisão de transporte retorna ao
  operador, sem certificação de escrita/barreiras de merge/base/CI.
- 2026-11-05 — **Nova aprovação explícita do operador**, continuação de `d54b95f`:
  HTTPS Node privado somente GET `/app`, GET instalação configurada e POST de seu
  access token; **demais operações conservam gh api com tokens reduzidos**.
  Proveniência: instrução “NEW OPERATOR DESIGN APPROVAL” desta execução e
  `/tmp/software-factory-mvp-test-authorization.md`; adendo no contrato canônico
  `software-factory/issues/11-github-app-contract.md`, spec e interfaces. Sem ADR,
  transporte global novo, fallback ou Workflows. RED/GREEN nos seams aprovados,
  gate final Node 24.21.0 **73/73** + arquitetura/lint/build/typecheck.
  **App 5569788 e instalação 177599217/Sanmoo agora confirmadas** por HTTPS real;
  tracker token exato (um repo, metadata R/issues W) emitido 201 e leituras gh reais
  200; tracker completo com limitações declaradas. CodeRepository continua bloqueado
  antes de emissão: faltam exatamente **checks R, statuses R, actions R,
  administration R** no teto observado. Sem ampliar grants automaticamente; base
  não consultada. Doctor exit 3, histórico 0, proprietário encerra 0. Sem mutações,
  push, modelos/VM/sandbox03 ou prova de barreiras. Token opaco real exigiu correção
  token68 com RED/GREEN; ensaios anteriores e limitações preservados na
  [evidência](../../../docs/evidence/04-github-app-access-diagnostics.md#continuação-com-https-app-explicitamente-aprovado--2026-11-05).
  **BLOCKED/PARTIAL; ticket não resolvido, critérios sem marcação** até prova de
  todos os critérios com permissões mínimas corrigidas pelo operador.
- Revisão local do HTTPS sobre `c05977f`: **F1/P2 corrigido**, preservando a espera
  sanitizada de rejeição conhecida da emissão. RED público 429/403 com
  `Retry-After: 37` falhou `undefined !== 37`; GREEN 2/2 após alteração mínima.
  Fixture independente confirma POST único/trace sem replay e zero gh operacional,
  também para emissão incerta (orientação de reconciliação inalterada). **P3 não
  reproduzido no Node 24.21.0**: regex sem `m` já rejeita LF/CR/CRLF; seis novos
  negativos passam antes de alteração de produção e confirmam zero gh, incluindo
  TAB/NUL/DEL. Regex preservado por decisão de supervisão; sem alegar RED/fix de
  P3. Pontuação token68/padding legítimos continuam aceitos. Gate nesta worktree
  04: foco **35/35**, `npm test` **81/81** + arquitetura/lint/build,
  `npm run typecheck`, `git diff --check` passam. [Evidência precisa e limites](../../../docs/evidence/04-github-app-access-diagnostics.md#revisão-https-local--f1p2-corrigido-p3-não-reproduzido).
  Nenhum GitHub/credencial/chave/modelo/VM real nem suite de outra worktree.
  **BLOCKED/PARTIAL permanece**, direitos mínimos pendentes do operador e repo/base
  não verificados; sem resolução, integração ou publicação. Revisão independente
  da correção ainda necessária.
