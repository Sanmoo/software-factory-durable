# Arquitetura

## Intenção

A fábrica é um monólito modular: um processo de controle, workers e adapters por Work, compostos a partir de módulos de `src/` com responsabilidades separadas, como a [spec §2](../../.scratch/software-factory/spec.md) e as [interfaces públicas](../../.scratch/software-factory/module-public-interfaces.md) definem. Os sete módulos de aplicação (`control`, `workers`, `sandbox`, `issue-tracker`, `code-repository`, `records`, `protocol`) mais a base neutra `contracts` e as zonas técnicas privadas `platform/github` e `platform/host` são as fronteiras; `src/entrypoints` são raízes de composição, não um módulo.

As fronteiras são verificadas, não confiadas: um import cruzado que o mapa não permite falha antes de chegar a revisão. O modelo de domínio (`src/contracts` e as regras puras de `src/control/rules`) não importa persistência, I/O, SDK nem relógio ambiente; dados e tempo são injetados, para que as regras sejam testáveis sem infraestrutura.

## Julgamento

- Conceito novo entra no módulo cujo vocabulário ele usa ([GLOSSARY.md](../../GLOSSARY.md)). Só abra módulo novo quando o conceito tiver dono, linguagem e ciclo de vida próprios; isso pede um ADR em [docs/adr/](../adr/).
- Uma aresta nova entre módulos é uma decisão de arquitetura: proponha a mudança no mapa com o motivo, nunca um relaxamento oportunista de regra.
- Colaboradores de `control` entram por `import type`; implementações são compostas pelos entrypoints. Se uma regra pura precisa de um efeito, injete o dado ou a função, não o módulo.
- O CLI compõe validação de Sandbox, Protocol, Records e contratos, e só tipos de Control; `setup` é a exceção declarada que alcança Workers para o primeiro login OAuth.
- Fixtures de arquitetura afirmam a regra e os caminhos que falham, não só um código de saída não-zero.
- Abra um ADR quando a decisão for difícil de reverter, surpreendente sem contexto e fruto de um trade-off real.

## Onde estão os fatos

- Mapa de contextos, entradas públicas (`index.ts`), regras de composição, donos de SDK e ciclos: [.dependency-cruiser.cjs](../../.dependency-cruiser.cjs).
- Regras de carregamento analisável e proibições de relógio/I/O nas regras puras: [eslint.config.mjs](../../eslint.config.mjs).
- Testes das próprias regras de arquitetura: [test/architecture/](../../test/architecture/).
- Núcleo (`control`, `workers`) para limites mais estritos: a política de seleção em [scripts/test-runner/policy.json](../../scripts/test-runner/policy.json).
