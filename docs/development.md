# Desenvolvimento local — tickets 01–02 (e admissão do 07)

Os incrementos implementam preparação/diagnóstico offline, o gate da própria
Factory e controlador exclusivo com pausa/pedidos duráveis por socket privado.
O ticket 07 acrescenta polling somente leitura e admissão durável de um Trabalho por
Ticket elegível (`factory list`, `factory show <work>`); ver
[evidência 07](evidence/07-unique-ticket-admission.md). O ticket 08 reavalia a cada rodada o grafo nativo
`blocked_by` de cada Trabalho pendente (repos executáveis e `dependencyRepositories` só de leitura) e mostra a
avaliação/seleção em `list`/`show`/`status`; ver [evidência 08](evidence/08-native-dependency-gating.md).
Não iniciam workers/VMs nem registram serviços.
Despacho permanece fechado, inclusive após `unpause`; não existe scheduler paralelo.
Não é uma release autocontida homologada; a construção/instalação verificada da release e a composição
de produção do ticket 32 estão em [evidência 32](evidence/32-self-contained-release.md). Evidências e
limites do controlador:
[controller-evidence.md](controller-evidence.md). Autoridade: [spec](../.scratch/software-factory/spec.md),
[interfaces](../.scratch/software-factory/module-public-interfaces.md), decisões
[operacionais](../.scratch/software-factory/issues/21-installation-operations-contract.md)
e [do adapter](../.scratch/software-factory/issues/19-gondolin-adapter-contract.md).

## Baseline fixada de desenvolvimento

- Node **24.21.0**, npm **11.19.0** (`.node-version`, `engines`, `packageManager`,
  `.npmrc` com engine-strict). Selecionar a instalação já disponível com o gerenciador
  local; nenhum comando deste projeto instala Node ou modifica o sistema.
- TypeScript **6.0.3**, `@types/node` **24.19.2**, ESM/NodeNext estrito, saída ES2023.
- Runtime: YAML **2.9.1**, Zod **4.6.7**. Nada de parser YAML próprio.
- Controle: Pi Durable **1.5.0** e Chord **1.5.0**, por suas exportações públicas;
  `Session`/`SqliteStorage` reais, adapter Node público configurado/verificado FULL.
  Node fixado embarca SQLite **3.53.4** (correção WAL-reset presente).
- Gate estático: dependency-cruiser **18.7.2**; ESLint **10.14.0** e parser TypeScript
  **8.72.1** para carregamento opaco e relógios/I/O ambientes nas regras puras.
- Versões/integridades transitivas: `package-lock.json`. Isto não fixa nem prova
  combinação de release Pi/Durable/Gondolin/QEMU/assets. `factory` é um launcher
  **de desenvolvimento**, usando o Node selecionado; a release futura fornece Node privado.

```sh
node --version                    # v24.21.0
npm --version                     # 11.19.0
npm ci
npm test                          # gate local completo, sem credenciais/modelos/remoto/VM
```

`npm test` executa arquitetura (antes de runtime), limpa somente `dist/`, compila e
verifica tipos **uma vez** e executa **todos** os testes locais compilados com
`node:test`/`node:assert/strict`. Fixtures inválidas são criadas em diretórios
temporários e analisadas separadamente; não são fontes de runtime nem excluem
testes autorais da análise. `node_modules/` não é fonte autoral; seus imports
continuam visíveis ao checker, sem percorrer o conteúdo vendorizado.

## Feedback incremental e grupos de risco

```sh
npm run check:architecture
npm run typecheck
npm run build
node --test dist/test/entrypoints/doctor.test.js
node --test 'dist/test/entrypoints/controller*.test.js' dist/test/entrypoints/control-public.test.js
node --test dist/test/protocol/protocol.test.js
node --test --test-name-pattern 'alias' dist/test/architecture/architecture-gate.test.js
npm run watch
# Em outro terminal, após a primeira emissão do watch:
node --test --watch dist/test/entrypoints/configuration.test.js
```

Subconjunto/watch não equivale à suíte completa. Antes de integrar: `npm ci`,
`npm test`, diagnósticos TypeScript/ESLint dos paths alterados e evidências fiéis
das fronteiras alteradas. Observar tempos com `time npm run check:architecture`,
`time npm run build` e `time node --test 'dist/test/**/*.test.js'`.
Não há engine próprio de impacto/cache.

| Grupo | Execução e fronteira |
| --- | --- |
| Local completo | `npm test`: CLI pública, YAML, filesystem temporário real, probes read-only e checker executável. Sem credenciais reais, modelo, remoto ou VM. |
| Integrações reais | Grupo separado, **não implementado neste ticket**. Pi Durable/SQLite, SDK/sessões, protocolo, Gondolin/KVM/FUSE/Docker/TLS e GitHub terão comandos próprios junto às respectivas implementações, nunca inclusão automática em `npm test`. Exigem preparo/autorização específicos. |
| Agentes reais | Grupo separado, **ainda sem comando executável**: skills, dois revisores, modelos e custos autorizados. Um dublê não prova essa fronteira. |
| Pilotos | Grupo separado, **ainda sem comando executável**: Tickets reais, recursos/conta/GitHub/modelos autorizados e avaliação/merge humanos. Não é smoke test local. |

O ticket 32 acrescenta a ferramenta de construção da release
(`dist/src/entrypoints/release-build.js`, só desenvolvimento; nunca no host operador) e a composição de
produção do controlador; ambos estão cobertos pelo gate local com assets sintéticos e tar real. A
construção/verificação com os assets reais e o boot continuam grupos autorizados separados
([evidência 32](evidence/32-self-contained-release.md)). O restante de V-16 (release nova com perguntas
pendentes, migração interrompida, upgrade) pertence aos incrementos seguintes. Doctor não dispensa
nenhuma prova real afetada.

## Grafo executável

`.dependency-cruiser.cjs` expressa a matriz da spec 2.4 diretamente: `contracts`,
`protocol`, `records`, `platform/github`, `platform/host`, `issue-tracker`,
`code-repository`, `sandbox`, `workers`, `control`. Só se criam diretórios quando
há implementação real. Imports cruzados usam `index.ts`; não há deep imports,
ciclos (inclusive de tipos) ou alias de bypass. `tsconfig.json` é o mesmo para
compilação e resolução do checker (`@factory/*`); aliases não reescritos pelo
`tsc` não são usados no runtime ESM.

- Controle só importa contratos dos colaboradores via `import type`; Workers só
  importa tipos da projeção pública de ferramentas Sandbox. Implementações injetadas
  são compostas pelos entrypoints, não pelas regras.
- CLI compõe validação Sandbox/Protocol/Records/contratos e somente tipos de Control;
  controlador pode compor os módulos/infraestrutura; worker não compõe Control,
  Sandbox ou emissor; adapter não compõe Control, Workers ou emissor.
- Testes de módulo podem alcançar seu seam privado na zona correspondente;
  `test/entrypoints` e `test/architecture` são composição de testes, sujeitos às
  entradas públicas/ownership, não uma exclusão geral. Fonte nova fora das zonas,
  inclusive fora de `src/`, falha até revisão explícita da classificação.
- SQLite e Pi Durable somente em `control/durable`; Pi coding-agent somente em
  Workers; Gondolin somente em Sandbox; Octokit somente nos adapters/infra GitHub.
- `control/rules` não importa persistência/I/O/SDK; dados/tempo são injetados.
  ESLint rejeita relógios/ambiente globais e carregamentos calculados/opacos.
  Imports dinâmicos literais continuam analisáveis pelo dependency-cruiser.

O checker reporta arquivo/dependência/regra. Fixtures afirmam **a regra e os paths**,
não só exit não-zero. O reporter JSON do dependency-cruiser retorna zero ao gerar
grafo, mesmo inválido: os testes usam `summary.advisedExitCode` **e**
`summary.violations`; o comando de gate usa `err-long`, que falha por violação.
Análise estática não prova mensagens/protocolo/isolamento em runtime nem é proteção
contra código host comprometido. Nova aresta requer revisão, não relaxamento oportunista.
