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
npm run test:fast                 # ciclo de TDD (≤3 min, sem lock)
npm run test:ci                   # gate de integração (≤10 min, lock da máquina); `npm test` é o mesmo
```

`npm run test:ci` executa arquitetura (dependency-cruiser + ESLint `--max-warnings 0`), limpa somente
`dist/`, compila e verifica tipos **uma vez** e executa **todos** os testes locais compilados com
`node:test`/`node:assert/strict`, em paralelo com uma lane serial para as exceções. Camadas, manifesto
`test/tiers.json`, lock, tetos e regras para quem escreve teste: [docs/guides/testing-strategy.md](guides/testing-strategy.md)
(decisão do ticket 36, que substitui a regra "um arquivo compilado por vez" do handoff). Fixtures inválidas são criadas em diretórios
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
`npm run test:ci`, diagnósticos TypeScript/ESLint dos paths alterados e evidências fiéis
das fronteiras alteradas. O relatório do runner traz os tempos (estática, lanes, espera no lock,
10 arquivos mais lentos). Não há engine próprio de impacto/cache.

### Camada `full` noturna (instalação explícita pelo operador)

`npm run test:full` acrescenta ao `ci` os testes de sandbox de disco real (com
`FACTORY_SANDBOX_TEST_ROOT` numa raiz privada nova sob `${XDG_CACHE_HOME:-~/.cache}/sft/`, em disco:
a admissão de storage recusa tmpfs; caminho curto por causa dos sockets) e uma segunda passada em
ordem aleatória. A execução noturna é versionada, **não instalada**:

- `scripts/test-runner/nightly`: atualiza o worktree destacado `<checkout>/.worktrees/nightly-full`
  para a ponta local de `main` (validação integral da linha integrada), sem fetch nem instalação, e
  roda `full --report` em `${XDG_STATE_HOME:-~/.local/state}/software-factory/nightly-tests/`.
  O `node_modules` desse worktree é mantido pelo operador (`npm ci` nele); divergência vira relatório
  vermelho pelo próprio runner.
- `scripts/test-runner/systemd/software-factory-nightly-tests.{service,timer}`: unit do usuário (03:30).

Instalação, quando o operador decidir:

```sh
cp scripts/test-runner/systemd/software-factory-nightly-tests.* ~/.config/systemd/user/
# ajustar SF_NIGHTLY_REPO e PATH (Node 24.21.0) no .service
systemctl --user daemon-reload
systemctl --user enable --now software-factory-nightly-tests.timer
```

Relatório vermelho vira ticket; nunca bloqueia integração. `systemctl --user status
software-factory-nightly-tests.service` mostra a última execução.

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

A intenção, o julgamento e os ponteiros da arquitetura estão em [docs/guides/architecture.md](guides/architecture.md);
o mapa executável é [.dependency-cruiser.cjs](../.dependency-cruiser.cjs). O reporter JSON do dependency-cruiser
retorna zero ao gerar grafo, mesmo inválido: os testes usam `summary.advisedExitCode` **e** `summary.violations`;
o comando de gate usa `err-long`, que falha por violação. Análise estática não prova mensagens/protocolo/isolamento
em runtime nem é proteção contra código host comprometido.
