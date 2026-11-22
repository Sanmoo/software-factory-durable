# Padrões de código

## Julgamento

- Nomeie tipos, funções e variáveis pelos termos do [GLOSSARY.md](../../GLOSSARY.md), no identificador inglês que ele registra; um sinônimo listado em _Avoid_ é corrigido no código, não tolerado.
- Prefira um módulo profundo atrás de uma interface pequena (`index.ts`) a vários módulos rasos que expõem detalhes.
- Código novo mora no módulo cujo vocabulário usa e na camada que lhe cabe: regra pura em `src/control/rules`, efeito durável em `src/control/durable`, integração com terceiros no adapter do módulo dono.
- Tempo, aleatoriedade e I/O entram por parâmetro nas regras puras; nunca por global.
- "Harness" e "gate" têm sentido de domínio; ao falar de engenharia, escreva "engineering harness" e "quality gate" ([ADR 0002](../adr/0002-qualified-engineering-harness-terms.md)).

## Onde estão os fatos

- Formatação: [.prettierrc.json](../../.prettierrc.json), com as exclusões de travessia em [.prettierignore](../../.prettierignore); o reformat inicial está em [.git-blame-ignore-revs](../../.git-blame-ignore-revs). Testes que afirmam a forma do código-fonte leem a fonte por [source-text.ts](../../test/architecture/source-text.ts), para que a formatação não mude o que afirmam.
- Linter (conjunto `recommended` do typescript-eslint, a convenção de `_` para bindings mantidos de propósito e as regras de carregamento): [eslint.config.mjs](../../eslint.config.mjs).
- Supressões do ESLint: cada `eslint-disable` é um achado tolerado e precisa de entrada aprovada em [lint-tolerated.json](../../scripts/test-runner/lint-tolerated.json); uma supressão nova é corrigida, não acrescentada à política.
- Termos evitados: as linhas _Avoid_ do [GLOSSARY.md](../../GLOSSARY.md), lidas pelo [checker](../../scripts/test-runner/avoided-terms.ts).
- Segredos: o gitleaks fixado em [mise.toml](../../mise.toml) varre o histórico de HEAD e os arquivos não commitados, casados com [secrets-tolerated.json](../../scripts/test-runner/secrets-tolerated.json) pelo [wrapper](../../scripts/test-runner/secrets.ts). Um token sintético de teste é escrito em partes concatenadas (`'ghs_' + '…'`), para que o scanner não o reconheça; um achado novo é corrigido antes do commit, porque depois dele só sai do histórico com push forçado.
- Tipos estritos: [tsconfig.json](../../tsconfig.json).
- Quais quality gates existem e sobre qual escopo: [scripts/test-runner/policy.json](../../scripts/test-runner/policy.json).
