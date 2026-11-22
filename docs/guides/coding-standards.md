# Padrões de código

## Julgamento

- Nomeie tipos, funções e variáveis pelos termos do [GLOSSARY.md](../../GLOSSARY.md), no identificador inglês que ele registra; um sinônimo listado em _Avoid_ é corrigido no código, não tolerado.
- Prefira um módulo profundo atrás de uma interface pequena (`index.ts`) a vários módulos rasos que expõem detalhes.
- Código novo mora no módulo cujo vocabulário usa e na camada que lhe cabe: regra pura em `src/control/rules`, efeito durável em `src/control/durable`, integração com terceiros no adapter do módulo dono.
- Tempo, aleatoriedade e I/O entram por parâmetro nas regras puras; nunca por global.
- "Harness" e "gate" têm sentido de domínio; ao falar de engenharia, escreva "engineering harness" e "quality gate" ([ADR 0002](../adr/0002-qualified-engineering-harness-terms.md)).

## Onde estão os fatos

- Linter (conjunto `recommended` do typescript-eslint, a convenção de `_` para bindings mantidos de propósito e as regras de carregamento): [eslint.config.mjs](../../eslint.config.mjs).
- Termos evitados: as linhas _Avoid_ do [GLOSSARY.md](../../GLOSSARY.md), lidas pelo [checker](../../scripts/test-runner/avoided-terms.ts).
- Tipos estritos: [tsconfig.json](../../tsconfig.json).
- Quais quality gates existem e sobre qual escopo: [scripts/test-runner/policy.json](../../scripts/test-runner/policy.json).
