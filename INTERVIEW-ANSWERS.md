# Respostas da entrevista

## Adoption

Confirmadas pelo mantenedor na entrevista de adoção de 2026-11-21/22 (acceptance run de Sanmoo/skills#27), sobre `main` em `fa17c6456b0e`, numeradas como na entrevista _Adoption_ da skill. Itens com letra refinam uma decisão.

1. Entregável e borda: a CLI `factory` do tarball de release construído. GitHub atrás da fixture local de `gh`; modelos atrás de providers roteirizados. GitHub e modelos reais ficam nas receitas de qualificação autorizadas pelo operador.
2. Domínio: contextos = as 10 zonas do dependency-cruiser; `src/entrypoints` = raízes de composição. Core = control e workers; supporting = sandbox, issue-tracker, code-repository e records; generic = protocol e platform/*; contracts = shared kernel. "Harness" e "gate" ficam com o domínio; os Guides da adoção dizem "engineering harness" e "quality gate" (ADR). `GLOSSARY.md` só transcreve o PRD §3 com os identificadores ingleses (honra `map.md:21`).
3. Fronteiras: o mapa do dependency-cruiser, com o carve-out `cli-workers-setup-only`, é a declaração; a prosa de `docs/development.md` sobre a CLI está desatualizada. O filtro `(^|/)dist` é ancorado na raiz para que alvos de terceiros fiquem visíveis. `sdk:*-owner` vale só para produção em `src/`.
4. Contrato de regressão: a suíte `test:ci` atual; jornadas prioritárias `journey-composed` e `release-install/artifact/upgrade`; investigação de teste vermelho em até 1 h por etapa; sem testes de caracterização novos, salvo quando uma etapa muda um workflow sem teste.
5. Ferramentas: retidos tsc 6.0.3, ESLint 10.14.0 com suas regras, dependency-cruiser 18.7.2, o runner e o checker documental. Adicionados Prettier 3.9.10, typescript-eslint 8.72.1 recommended, ESLint `complexity` 10, jscpd 5.4.2, gitleaks 8.30.1 (pin em `mise.toml`) e `npm audit --audit-level=high`.
6. Entry Points e CI: `test:fast` é o rápido; o runner é o completo, com `test:ci` como validação por mudança e `test:full` como integral. O CI é o `test:ci` supervisionado local (ADR); o GitHub Actions continua documental. O noturno systemd passa a validar `main`, e o mantenedor o instala.
7. Lacunas: portar o ferramental de #24 para branches de tarefa a partir de `main`, refazendo as partes mecânicas e todas as provas nesta árvore. E2E bloqueado (assets de guest bootáveis, credenciais de modelo, autorização por execução); Mutation pendente.
8a. Medir num clone descartável fora da aplicação: feito em `fa17c645`; resultados no plano e no inventário.
8b. O reformat é uma etapa própria, executada só quando o mantenedor sinalizar que os branches ativos estão integrados ou pausados; as etapas que não dependem dele vêm antes.
8c. Ordem das etapas: S1 modos, política, Types, Context boundaries, Dependency rule, Guide pointers, Guides; S2 Lint, Avoided terms, Vulnerabilities; S3 níveis Unit e Integration; S4 Format; S5 Secrets; S6 Static metrics. E2E bloqueado; Mutation pendente.
8d. Lint: os 125 achados medidos são corrigidos, nada é tolerado; a convenção de `_` é configurada em `no-unused-vars`.
8e. Static metrics: escopo `src/`; `test/` e `scripts/` declarados fora do escopo (não são produção). As 412 funções de src acima de 10 são tolerados por identidade (arquivo + função + valor). Duplicação de 1,12% em src, sem tolerância.
8f. Secrets: tolerados por decisão explícita os 6 fingerprints em `.scratch/.../alpine-guest-evidence.json`, o template PEM em `src/sandbox/lambda/transport.ts` e os 16 achados do histórico de HEAD; os 9 tokens sintéticos de `test/` são reescritos.
8g. Ordem aleatória: `finite-qualification.test.ts` é investigado em S3 dentro de 1 h, sem quarentena nem retry; se não fechar, o integral fica vermelho e registrado.
8h. Orçamento: validação por mudança ≤ 15 min; integral às 03:30 sobre `main`, ≤ 2 h; o `TMPDIR` curto é pré-requisito documentado.
8i. Mutation: pendente, com a decisão de runner, cadência ou escopo em aberto.
8j. Avoided terms: Work → job; Slot → seat; Repair → hotfix ("lane" fica de fora).
9. Plano aprovado pelo mantenedor em 2026-11-22, como registrado em `ADOPTION-PLAN.md`.
