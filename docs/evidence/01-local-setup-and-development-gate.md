# Evidência — ticket 01: instalação local e gate de desenvolvimento

Data: 2026-11-05. Escopo: [ticket 01](../../.scratch/software-factory-mvp/issues/01-local-setup-and-development-gate.md).
Autoridade: spec 2.2/2.4/7/11.1–11.3/13.4; contrato operacional e contrato Gondolin
19, sem alterar decisões de produto. Autorização: implementação local autônoma,
dependências npm de desenvolvimento e testes em temporários; sem modelos,
credenciais reais, GitHub remoto, VM, instalação de pacotes do sistema ou alteração de serviços.

## Composição efetivamente exercitada

- CLI compilada real → bootstrap/YAML/Zod → factory pública Sandbox `validate`
  → inspeção host read-only. Setup/doctor não constroem Controle, Workers ou DB.
- Setup em diretórios temporários reais: mkdir/exclusive-create/lstat/permissões,
  preservação de conteúdo desconhecido e credenciais sintéticas.
- Importação pública com permission model do Node: leitura somente do checkout,
  nenhuma permissão de escrita/spawn/leitura de home. Importação passa sem efeitos.
- dependency-cruiser/ESLint **reais**, versões fixadas, com fixtures em temporários;
  SQLite/Pi/Gondolin/Octokit não são executados. Pacotes fictícios nas fixtures
  existem somente para testar resolução/ownership, não provam integração dos SDKs.
- Probes normais executam somente `--version`. Um teste com executáveis sintéticos
  no PATH verifica argumentos/ambiente e versão systemd inteira; é S, não prova QEMU.

## V-16 — subcasos deste incremento

| Subcaso / vínculo | Nível fiel | Expectativa → observado | Resultado / lacuna |
| --- | --- | --- | --- |
| Setup repetido, RF-01/RNF-02 | I (filesystem temporário real) | Segunda execução cria zero recursos; config/credenciais/dados/permissões desconhecidas preservados; repos vazios → confirmado pela CLI | Aprovado neste recorte; sem release autocontida |
| Paths privados/incompatíveis | I | 0700/0600 em recursos novos, symlink recusado antes dos filhos, socket longo bloqueado sem criar socket → confirmado | Aprovado; sem promessa de contenção host adversarial |
| Configuração íntegra, RF-01/RNF-05 | S + parser real | Modelos dos três papéis, operadores explícitos ([] permitido), repo/base/App/installation/Workflows; defaults exatos; inválido não expõe effective parcial → confirmado | Aprovado; não testa autenticação nem aplicação operacional futura |
| Doctor offline | I read-only + S do ambiente de subprocessos | Relata versões/paths/permissões/KVM/systemd/storage/socket; preserva árvore e DB sentinela; não lê credenciais → confirmado | Aprovado como diagnóstico, **não** como funcionalidade de KVM/systemd/Docker |
| Ausência de perfil pessoal/efeitos ao importar | I (permission model Node) | Importar CLI/Sandbox sem escrita/spawn/acesso ao home → passa | Aprovado nos módulos implementados |
| Gate arquitetural da Factory | Análise estática executável | Import público permitido; deep import/inversão/ciclo de tipos/alias/SDK/unclassified recusados pela regra e paths esperados → confirmado | Aprovado; não prova mensagens/protocolo/isolamento runtime |
| Release/assets/run/serviço/upgrade/migrações | Não executado | Fora do ticket 01; pertencem aos próximos incrementos de V-16 | **Não homologado**; nenhuma dispensa ou verde inferido |

Nenhuma evidência deste documento declara CA/RF/RNF completos do MVP. Doctor mantém
`kvm-functional`, `storage-lock-durability`, `docker-runtime` e supervisão systemd
não comprovada explicitamente `unverified`. Statfs não prova lock/fsync; versão ou
acesso à KVM não prova boot, FUSE, Docker/TLS ou capacidade/concorrência.

## Red → green, em slices verticais nos seams aprovados

Testes foram escritos/invocados antes da implementação de cada comportamento;
fontes dos testes em `test/entrypoints/*` e `test/architecture/architecture-gate.test.ts`.
[Excertos reais preservados](01-red-green.txt) incluem falhas e passes, sem segredos.

| Slice | Red observado | Green observado |
| --- | --- | --- |
| Setup repetível | CLI compilada ainda inexistente (MODULE_NOT_FOUND) | Recursos próprios/preservação passam |
| YAML/defaults | Doctor ainda indisponível | Configuração efetiva completa com defaults exatos |
| Configuração inválida | Ref `topic/.hidden` aceita indevidamente (exit 0 em vez de 2) | Validação Git ref rejeita; todos os casos inválidos sem effective/segredo |
| Doctor offline/socket | `scope` ausente e checks inexistentes | Diagnóstico estruturado sem alteração da árvore |
| Deep import/inversão | Fixture proibida passava sem regra | Regra pública/zona e paths exatos |
| Ciclo de tipos | Só inversão era detectada; `no-cycles` faltante | Regra de ciclo de tipos detectada |
| SDK/ownership | SQLite fora de Control passava | Regra `sdk:sqlite-owner` e demais SDKs resolvidos |
| Fonte não classificada | Órfão `src/misc/escape.ts` passava | Regra `classified-source` (também fonte fora de src) |
| Contratos/composição | Control importava implementação; worker compunha Control | Regras `control-contracts-only`, `composition:worker`, `cli-control-types-only` |
| Clocks/carregamento/I/O | Date.now/computed import/I/O sem regras passavam | ESLint + dependency-cruiser recusam; extensão .mjs também testada |
| Setup path inseguro | Criava assets/releases antes de rejeitar symlink | Preflight sem criação parcial de filhos |
| Setup diagnóstico | `code`/diagnostics ausentes | `SETUP_PREPARED` separado de config incompleta |
| Argumentos | Comando inválido produzia erro genérico; flags não validadas | `INVALID_ARGUMENTS`, sem alterações |
| Config symlink | Config externa era lida (CONFIGURATION_INVALID) | CONFIGURATION_UNREADABLE, sem reparo de permissões |
| Referência de credencial | Campo credentialFile ainda recusado | Somente referência privada relativa; paths pessoais/segredos recusados |
| Versão systemd | `777` retornava null por regex só de versões pontuadas | Versão inteira reportada; sem ambiente pessoal herdado |
| Operadores vazios explícitos | [] recusado indevidamente | [] aceito sem identidade/fallback ou autorização remota |

O harness inicial do checker foi corrigido: reporter JSON gera exit 0 mesmo com
violações; usam-se `summary.advisedExitCode` e a regra/dependência, não esse exit.
O caminho do binário e o nome normalizado `fs/promises` também foram conferidos
contra o analyser real. Falhas de configuração/harness não contam como detecção
arquitetural. Prova independente com reporter `err-long`: inversão Protocol →
Control resultou em exit 1, `zone:protocol`, paths exatos (incluída no transcript).
Aliases já foram cobertos pela resolução TS da regra pública, sem parser próprio.

## Validação local

Baseline: Node 24.21.0 / npm 11.19.0, selecionados de instalação **já existente**.
[Transcript do gate completo](01-local-gate.txt):

- `npm ci`: passou, 133 pacotes de desenvolvimento/runtime instalados a partir do lockfile.
- `npm test`: arquitetura sem violações (22 módulos, 46 dependências), build/typecheck
  ESM estrito e **30 testes locais, 30 passes, zero falhas/skip/todo**. Test runner ~10 s;
  isso é baseline observada, não SLA.
- `npm run typecheck`: passou. ESLint de `src`, `test`, configs alteradas com
  `--max-warnings 0`: passou. `sh -n factory` e `./factory --help`: passaram.
- `git diff --check`: passou. Ferramenta de diagnósticos LSP/extension não foi
  disponibilizada ao worker; diagnósticos ativos disponíveis foram tsc/ESLint/shell.
- `npm audit --omit=dev --json`: zero vulnerabilidades runtime na consulta.

### Risco residual de dependências de desenvolvimento

`npm audit --json` **não está limpo**: 5 registros moderados, mesma causa raiz
[minimatch GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
(amplificação de globparts/DoS). Lockfile usa minimatch **10.2.6** por:

- `eslint@10.14.0 → minimatch@10.2.6`;
- `eslint@10.14.0 → @eslint/config-array@0.23.5 → minimatch@10.2.6`;
- `@typescript-eslint/parser@8.72.1 → @typescript-eslint/typescript-estree@8.72.1 → minimatch@10.2.6`.

O advisory cobre `>=7.0.0 <11.0.1`. `npm view minimatch@10 version --json` mostrou
10.2.6 como maior patch disponível dessa major; a correção indicada é **11.0.1**,
fora das faixas compatíveis. Os cinco registros agregam eslint/config-array/parser/
estree/minimatch, não cinco falhas runtime independentes. Reachability aqui é
somente tooling local com globs/configuração versionados; não há dependência
runtime desses pacotes, e os repositórios processados não executam este gate no
controlador. Permanece risco de DoS no desenvolvimento com globs hostis.
Não aplicado `npm audit fix --force`, downgrade amplo ou override major. Reavaliar
quando os consumidores publicarem dependências compatíveis corrigidas.

## Integração e revisão

Destino deste worker: **somente** branch local `implement/software-factory-mvp-01`,
baseada em `integration/software-factory-mvp` (`2d3ffa9`). Commit/inclusão da ponta
corrente e gate pós-incorporação são registrados no relatório final do worker.
Nenhum merge em main, push, remoção de worktree ou execução de piloto foi feito.
Revisão independente exigida pelo supervisor continua separada da evidência do implementador.
