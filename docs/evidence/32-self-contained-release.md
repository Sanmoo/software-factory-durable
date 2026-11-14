# Ticket 32 — release autocontida, verificável e composição de produção

Escopo desta evidência: artefato de release (manifesto/integridades/proveniência/créditos/licenças,
Node/SDKs/assets/skill packs fixados), preparação/instalação/diagnóstico de uma release extraída e
composição de produção de execução/reviews/credenciais que os tickets 09/10/12/20 adiaram para "ticket 32".
Tudo foi executado localmente, sem rede, GitHub, credenciais, modelo, VM/QEMU, systemd ou sudo.
**A release real com os assets reais não foi construída nem homologada aqui**; a receita one-shot está
abaixo para o supervisor.

## O que foi implementado

| Peça | Arquivo | Contrato estendido |
| --- | --- | --- |
| Manifesto, inventário exato, verificação e diagnóstico da release | `src/entrypoints/release.ts` | novo entrypoint CLI (mesma classificação de `configuration.ts` no checker) |
| Construção da release (ferramenta de desenvolvimento) | `src/entrypoints/release-build.ts` | novo entrypoint CLI; nunca roda no host operador |
| Composição de produção | `src/entrypoints/controller/composition.ts` | usa as portas públicas aprovadas (`ExecutionPorts`, `createSandbox`, `createWorkers`, `createBuilderCredentials`/`createRepositoryFetchCredentials`) |
| Forma de release do perfil Gondolin privado | `src/sandbox/gondolin-sdk-profile.ts`, `src/sandbox/index.ts` | `prepareReleaseGondolinSdk`, `verifyGondolinSdk`, `gondolinSdkProfile` pela entrada pública do Sandbox |
| Raiz de instalação da release, `setup --service`, doctor da release | `src/entrypoints/cli.ts`, `setup.ts`, `doctor.ts`, `configuration.ts` | CLI/setup/doctor existentes |
| Bootstrap do controlador | `src/entrypoints/controller/owner.ts` | verifica a release antes do storage e passa as portas de execução |

Nada de broker, scheduler, registry de DI, bundler ou runner TypeScript: a release distribui o
JavaScript já emitido por `tsc` e as dependências runtime do lockfile.

### Manifesto (`releases/<release>/release-manifest.json`)

- `files`: inventário exato da árvore da release (caminho/tipo/modo/tamanho/sha256, links relativos
  internos), conferido byte a byte na instalação.
- `node`: versão e sha256 do Node privado distribuído (`node/bin/node`) e licença (`node/LICENSE`).
- `guestAssets`: caminho `assets/guest/<manifest-sha256>/`, o pin do manifesto e o inventário dos assets
  preservados. Todo arquivo (inclusive `manifest.json`, kernel, initramfs e rootfs) é re-hasheado dos bytes
  na verificação; a entrada `manifest.json` precisa ter exatamente o hash do pin (esquema).
- `files`/`guestAssets.files` sem caminhos duplicados ou que colidem por caixa (esquema e inventário).
- `metadata.runtime.omittedEdges`: arestas opcionais não distribuídas e o motivo (`platform-excluded`,
  `optional-peer`).
- `production`: perfil de worker de produção (`factory-production-v1`), papel/perfil de cada papel,
  skill pack, limites (`modelBudget` = requests/ferramentas; **nenhum deadline de relógio**), ferramentas
  por papel, prompts por hash e o pin do perfil privado do SDK/Gondolin.
- `qualification`: `status: unqualified` e a declaração explícita de que o manifesto não afirma cobertura
  funcional; checksums e build bem-sucedido não são qualificação (AC8).
- `metadata` (informativo, fixado pela construção): fonte (commit/data/dirty), plataforma, versões do
  Node (V8/OpenSSL/SQLite/módulos), SQLite embutido (`node:sqlite`, sem binding separado), pacotes
  runtime do lockfile (versão+integridade+licença+arquivos de licença), exclusões (devDependencies e o
  pacote upstream do SDK, substituído pelo perfil privado verificado), Pi coding-agent/Pi Durable/Chord,
  Gondolin (perfil e forma de release), assets (buildId, checksums, Alpine, helpers por basename), perfil
  guest (arquivos e pacotes apk), skill packs (id/versão/manifesto/licenças/créditos), protocolo, formatos,
  instrumentos de desenvolvimento (TypeScript/npm/lockfile/checker/configuração/fixtures de arquitetura) e
  host de construção (kernel/OS/QEMU/tar).

O SHA-256 do próprio manifesto é reportado (`build-report.json`, `doctor.release.manifestSha256`) para o
operador comparar com o relatório publicado. **Não há assinatura**: um escritor da árvore pode reescrever
manifesto e arquivos; a prova é de integridade distribucional (corrupção/extração errada), não de autenticidade.

### Composição de produção

`owner.ts` verifica a release antes de abrir o storage (`RELEASE_INVALID`), depois monta:

- `sandbox`: `createSandbox({root, guestAssets, repositoryFetch, artifactSeeds})` — o pin de assets vem da
  release verificada, nunca do YAML;
- `workers`: um único perfil de worker (`factory-production-v1`, `factory-oauth`, provider/modelo
  `openai`/`gpt-6-luna`) para os três papéis, prompts distintos por papel;
- `reviews`: `reviewer-v1` + `imageSourceMaxBytes` (reviews paralelas já integradas pelo ticket 12);
- `credentials`: `createBuilderCredentials` vinculado aos repositórios configurados;
- `capacity`: `concurrency` configurada; `configuration`: bloco `sandbox` interpretado só pelo Sandbox;
- `builder`: skill pack `factory-skills-v3` (ask_user + handoff de review), `builder-v1`, `copyOutput`,
  `editSourceMaxBytes: 8192`.

Um papel cujo `provider`/`model` não seja exatamente o perfil da release recusa a composição inteira
(`CONFIGURATION_UNSUPPORTED`/`WORKER_PROFILE_UNSUPPORTED`, sem portas parciais e sem fallback — §6.1).
Checkout de desenvolvimento continua sem portas de execução (`EXECUTION_NOT_ENABLED`).

**Sem relógio de produção (spec §4.4, decisão do supervisor).** A composição não passa `deadlineMs` nem
qualquer política de prazo ao worker; `modelBudget` limita apenas requests/ferramentas/bytes. Sem timeout
de repositório configurado não há corte; o `timeoutSeconds` opcional por repositório (ticket 19) é o único
relógio. O perfil de release registra isso textualmente (`limits.deadline`) e não fixa minutos.

## AC → testes (nível de evidência)

Níveis: **R** regras/determinístico; **S** Control real + Pi Durable/SQLite temporário + dublês;
**I-local** componentes reais com fronteira externa substituída; **I** integração real (não executada aqui).

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Artefato com JS emitido, dependências runtime do lockfile, Node privado, skill packs e assets prontos; sem bundler/runner TS/framework novo | `release-artifact` (lista do tar: só `factory`, `releases/r32-test/`, `assets/guest/<sha>/`; sem `dist/test`, `.ts`, `src/`, TypeScript/ESLint/dependency-cruiser, SDK upstream; JS emitido + `node/bin/node` + skill packs presentes; archive+SHA-256 únicos; segunda construção no mesmo diretório falha `RELEASE_OUTPUT_EXISTS` antes de qualquer escrita), `release-composition` (portas reais) | I-local (assets sintéticos, tar do host, Node privado real) | Release real com assets34 e boot real |
| 2 Manifesto fixa Node/Pi/Durable/SDK/SQLite/Gondolin/QEMU/helpers/kernel/initramfs/Alpine/pacotes, perfil/ferramentas/skills/protocolo/formatos/limites e host das provas | `release-artifact` (node 24.21.0 e sha = binário; `metadata.sqlite.version`; Pi Durable 1.5.0, coding-agent 1.5.2 + perfil; Gondolin 0.14.0 + forma de release `../../node_modules`; skill packs v1–v3 com licenças/créditos; protocolo 1; pacotes apk; lockfile sha; 3 instrumentos; fixtures de arquitetura; `buildHost`; `production.limits.modelBudget`; `limits.deadline` sem minutos) | I-local | Hashes/números reais do host de qualificação (QEMU/helpers/initramfs) pertencem à construção real |
| 3 Build registra TypeScript/npm, lockfile e checker/configuração/fixtures, preservando créditos/licenças; instrumentos dev não exigidos no host | `release-artifact` (`build.typescript` 6.0.3, `build.dependencyCruiser.configSha256`, `build.eslint.configSha256`, `build.npm.executed=false`, lockfile sha, licenças por pacote, tokens inline legados `licenses[].type`), `release-install` (PATH só com canários: nenhum npm/npx/apk/sudo/node do host chamado; doctor não lê credenciais) | I-local | — |
| 4 Raiz canônica, releases imutáveis selecionadas explicitamente, assets preservados, configuração sem segredos, áreas privadas | `release-install` (setup cria só `releases/ assets/ credentials/ data/ environments/ run/ config.yaml`; `release:location/selected/node` ok; `permissions:releases/assets`; repetição sem sobrescrever config/credenciais/dados), `release-artifact` (raiz estrangeira recusada `RELEASE_ROOT_MISMATCH`, nada criado; conteúdo alterado `RELEASE_INTEGRITY_MISMATCH` sem reparo) | I-local | — |
| 5 Setup repetido não sobrescreve, não instala, não inicia Ticket, não usa sudo; dependências administrativas e KVM diagnosticadas sem fallback | `release-install` (segunda execução `created: []`; canários intactos; `kvm-access`/`kvm-functional`/qemu/systemd/storage no doctor; `environments`/`run` vazios), `local-setup`, `doctor` (existentes) | I-local + R | KVM funcional real (ticket 03/05) |
| 6 Primeiro plano e serviço systemd opcional com o mesmo lock; systemd dos ambientes requisito; workers sem administração host | `release-install` (`factory run` com lock tomado por outro processo → 73 `CONTROLLER_ALREADY_RUNNING`; `setup --service` só sob pedido explícito grava a unit (diretório padrão da conta pelo passwd, nunca `HOME`/`XDG_CONFIG_HOME`, ou `--service-directory` absoluto canônico), `preserved` se idêntica, `SERVICE_UNIT_CONFLICT` sem sobrescrever; unit usa o mesmo `factory run`, `Restart=no`, `NoNewPrivileges=yes`, sem `User`/capabilities/`ExecStartPre`, sem sudo/--root), `controller-ownership` | I-local | Registro/execução real de unit e segundo início pelo serviço |
| 7 Extração/setup/diagnóstico em instalação limpa e repetida comprovam artefato autocontido e integridades; paths/FS incompatíveis falham explicitamente, sem relocação livre | `release-artifact` (extração com `umask 077` sem `-p` → `RELEASE_INTEGRITY_MISMATCH` e controlador `RELEASE_INVALID` antes do storage; raiz estrangeira recusada), `release-install` (extração limpa, setup/doctor com o Node privado; `NODE_OPTIONS` pessoal ignorado; socket/FS/storage checks existentes), `doctor` (socket >107 bytes) | I-local | — |
| 8 Empacotamento não afirma cobertura; qualificação posterior usa a composição final e não apenas checksums/build | `release-artifact` (`qualification.status: unqualified`, texto "claims no functional coverage"; doctor `release:qualification: unverified`), `release-composition` (portas de produção efetivamente compostas) | R + I-local | Qualificação real posterior (tickets 34/35) |

### Red→green observado

- `release`/`release-composition`: o teste foi escrito primeiro e falhou por módulo inexistente
  (`TS2307`) e, no caso do checker, por 7 violações de classificação (`classified-source*`,
  `composition:cli`, `composition:controller`); a configuração do checker e os módulos vieram depois.
- Perfil Gondolin forma de release: teste novo falhou antes da implementação (link absoluto não verificava
  na raiz extraída); depois, `relative` + `dependencyLink` no registro, incluindo recusas de links
  alternativos (`GONDOLIN_DEPENDENCY_LINK`, `GONDOLIN_PROFILE_DRIFT`).
- `release-install`: falhou primeiro no caminho de `factory run` inexistente (setup ainda não criava a
  unit), depois na composição recusada; a ordem de `setup --service`/composição foi corrigida no teste e no
  produto.
- Ajustes encontrados pelos próprios testes: pacotes com campo legado `licenses[].type` ficavam sem licença
  no manifesto (corrigido); inventário/hash da árvore era o gargalo (paralelizado, WebCrypto até 256 MiB);
  `@types/node`/`@types/retry` entram legitimamente pela closure de pacotes upstream que os declaram como
  dependência de runtime (teste restrito a instrumentos de desenvolvimento).

### Correções da revisão independente (2026-11-14)

| Achado | Correção | Teste (falhou antes, passa depois) |
| --- | --- | --- |
| HIGH 1 assets fixados `trusted` (hash copiado do manifesto) | todo arquivo distribuído é re-hasheado; `pinned` removido; `manifest.json` dos assets = pin | `release-artifact` (rootfs alterado → `release:assets` blocked, doctor `RELEASE_INVALID`, controlador recusa sem storage); `release-inventory` (pin ≠ hash do `manifest.json` recusado) |
| HIGH 2 manifesto ausente ⇒ `development` | `RELEASE_MANIFEST_MISSING`; só `development-checkout.json` explícito, fora de `<root>/releases/<id>`, é desenvolvimento | `release-inventory` (sem marcador, marcador inválido, marcador dentro de `releases/<id>`); `release-artifact` (release sem manifesto: doctor 3, controlador `RELEASE_INVALID` antes do storage) |
| HIGH 3 closure incompleta/aninhada, SDK por caminho | toda entrada sob `node_modules` (topo e dependências aninhadas da cópia privada do SDK) pertence à closure; links `.bin` só para pacotes da closure; link Gondolin é a única exceção; nenhum `package.json` distribuído com o nome do SDK upstream; aresta obrigatória/peer ausente recusada; opcional omitido só se `os`/`cpu` exclui a plataforma | `release-inventory` (closure, `unaccountedShippedPaths`, `verifyShippedPackages`); `release-artifact` (build real passa) |
| MED 4 duplicados/caixa/links encadeados | esquema e inventário recusam; links por `realpath` dentro da árvore | `release-inventory` (`sub/up -> ..` + `sub/esc -> up/../outside`) |
| MED 5 owner com `{assets:false}` | `inspectRelease` sempre verifica os assets antes do storage | `release-artifact` |
| MED 6 unit sob `XDG_CONFIG_HOME` | padrão do passwd ou `--service-directory` explícito | `release-inventory`, `release-install` (HOME/XDG chamarizes intocados) |
| MED 7 raiz por presença do manifesto | raiz estrutural (`<root>/releases/<id>`), nunca do ambiente; lançador não exporta raiz | `release-inventory`; `release-artifact` (release sem manifesto com `--root` estrangeiro → `RELEASE_ROOT_MISMATCH`, nada criado) |
| LOW 8 saída existente | `RELEASE_OUTPUT_EXISTS` antes de qualquer efeito; `mkdir` exclusivo | `release-inventory`, `release-artifact` |
| LOW 9 links da fonte léxicos | `realpath` contido na fonte | `release-inventory` |
| LOW 10 doctor mascarava release bloqueada | código de topo `RELEASE_INVALID` (exit 3) | `release-artifact` |
| LOW 11 base parcial sem tombstone | tombstone `<base>.<fase>-intent.json` irmão da base, escrito antes dela; namespace `r32-v2` | `release32-qualification` |

A verificação real registrada abaixo (`r32-v1`) é anterior a estas correções; a receita agora usa `r32-v2`.

## Decisões de interpretação e questões abertas (operador)

1. **Perfil de worker único na release.** A release compõe `openai`/`gpt-6-luna` via OAuth da Factory para os
   três papéis; configuração com outro modelo é recusada (não há herança/fallback, §6.1). Um perfil por
   papel configurável exigiria decisão nova sobre empacotar múltiplos perfis e não foi aberto aqui.
2. **Sem relógio de produção** — decisão do supervisor registrada acima (spec §4.4).
3. **Guest assets distribuídos são os assets de desenvolvimento (assets34)**, copiados e fixados; o
   manifesto da release não os transforma em assets homologados (o perfil continua
   `gondolin-qemu-alpine-dev-v1`). A construção real usa `assets34` (read-only) e registra buildId/checksums.
4. **Node privado copiado da instalação local fixada** (bin/node + LICENSE); a construção offline não
   re-verifica checksums do release upstream do Node — declarado em `metadata.node.provenance`.
5. **A release distribui apenas `dist/src` (JS)**: testes, `.d.ts` e `.map` não fazem parte do host
   operador; os instrumentos de desenvolvimento ficam registrados no manifesto, não distribuídos.
6. **Serviço systemd**: a unit é escrita somente com `setup --service`, nunca iniciada/habilitada pelo
   setup (registro é passo administrativo explícito); paths com caracteres fora de `[A-Za-z0-9._/-]` são
   recusados (`SERVICE_PATH_UNSUPPORTED`).
7. **Assinatura/autenticidade** não é prometida; o SHA-256 do manifesto é o elo com o relatório publicado.
8. **Composição de produção não foi exercitada com VM/modelo/GitHub reais**; é composição de objetos
   públicos e recusas antes de efeito. A prova de fronteira real é a receita e o aceite posterior.

## Receita one-shot de verificação real (para o supervisor)

Fonte: `test/entrypoints/release32-qualification.ts` → `dist/test/entrypoints/release32-qualification.js`
(revisão `r32-v2`; raiz **nova** `/home/sanmoo/software-factory-test/r32-v2`; `r32-v1` foi consumida pela
verificação real). Import e `--plan` são inertes (teste com módulos de efeito negados). Fases **one-shot** com
tombstone exclusivo `r32-v2.<phase>-intent.json`, irmão da base e escrito antes dela (build); sem retry; uma fase consumida nunca reroda (construir uma
revisão nova). Rodar em ordem:

```sh
W=/home/sanmoo/dev/github.com/Sanmoo/software-factory-durable/.worktrees/software-factory-mvp-32
N=/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node
cd "$W" && git status --porcelain   # deve estar vazio (a build recusa árvore suja)
rm -rf dist && env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 \
  "$N" node_modules/typescript/bin/tsc -p tsconfig.json
"$N" dist/src/workers/sdk-profile.js >/dev/null \
  && "$N" dist/src/sandbox/gondolin-sdk-profile.js >/dev/null   # perfis privados verificados
for phase in --plan build verify install setup doctor controller-refusal; do
  env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 \
    "$N" dist/test/entrypoints/release32-qualification.js "$phase" || break
done
```

Limites: sem rede/GitHub/credenciais/modelo/VM/systemd/sudo/instalação de pacotes; nada fora de
`/home/sanmoo/software-factory-test/r32-v2` e seus tombstones irmãos é escrito (assets34 e o checkout só são lidos); pico de disco
~3,5 GiB (cópia dos assets ~860 MB + release ~300 MB + archive ~340 MB); orçamento de 15 min para a build e
120 s por comando. Observações gravadas em `r32-v2/observations/` (`*-result`, `*-held`).

Observações esperadas:

- `build-result`: `code RELEASE_BUILT`, `source.dirty=false`, `guestAssets=8efa506a…`, `outputs` com
  archive/sha256/manifesto/relatório; `guestProvenanceSha256` do `assets34/provenance.json`.
- `verify-result`: sha do archive = sidecar = relatório; manifesto = relatório; `violations: []`.
- `install-result`: extração 200, topo `assets/ factory/ releases/`.
- `setup-result`: primeira execução cria `config.yaml, credentials, data, environments, run`; segunda
  `created: []`; árvores de `releases/` e `assets/` idênticas antes/depois; `release:integrity/location/
  selected/node/assets` ok; `guest-assets:*` ok com os assets reais; `release:qualification` unverified;
  `diagnostics.code INVALID_CONFIGURATION` (o exemplo gerado é incompleto de propósito).
- `doctor-result`: exit 2 `INVALID_CONFIGURATION`; `versions.node 24.21.0`; checks de host (KVM, QEMU,
  systemd, storage) como observados.
- `controller-refusal-result`: exit 2 `CONFIGURATION_INVALID`; `data/control.sqlite` e `run/control.sock`
  ausentes (nada aberto antes da validação).

Não faz parte da receita: boot de VM, Docker/TLS, GitHub/modelo reais, registro do serviço, `factory login`
ou qualquer escrita remota; essas provas continuam nos grupos autorizados correspondentes (tickets 19–35).

## Gate local (executado em 2026-11-14)

Comandos exatamente como no baseline (`env -u NODE_OPTIONS -u NODE_COMPILE_CACHE
NODE_DISABLE_COMPILE_CACHE=1`, Node 24.21.0), na ordem:

| Etapa | Comando | Resultado |
| --- | --- | --- |
| Arquitetura estática | `dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long .` | rc=0, 297 módulos, 1747 dependências, nenhuma violação |
| Lint | `eslint.js . --max-warnings 0` | rc=0 |
| Compilação/typecheck | `tsc -p tsconfig.json` (uma vez, emite) | rc=0 |
| Suíte completa | cada `dist/test/**/*.test.js` **um arquivo por vez** (`--experimental-test-module-mocks --test --test-concurrency=1`), timeout 60 s (90 s em `entrypoints/normal-oauth`) | **136 arquivos, 912 pass, 0 fail, 10 skip** |

Skip esperados (inalterados por este ticket): `test/sandbox/gondolin.test.js` (skip:true, boot real) e os
skips de ambiente já existentes em `sandbox-filesystem`/`sandbox-prepare`/`sandbox-storage`.

Observação honesta: na primeira execução completa, `test/workers/sdk-profile.test.js` (ticket 05, não
alterado aqui) estourou seu timeout interno de 15 s sob carga concorrente da máquina (~5 de load average
com outros worktrees); o corpo leva ~6–7 s em repouso e o arquivo passou 3/3 isolado e na segunda execução
completa (912 pass). Nenhuma mudança deste ticket toca esse teste ou `sdk-profile`. O total de parede da
suíte é ~9–10 min neste host carregado; os testes de release representam ~50 s (duas construções reais +
duas extrações + oito execuções do Node privado).

## Verificação real autorizada — 2026-11-14 (supervisor)

Raiz nova `$HOME/software-factory-test/r32-v1`, seis fases one-shot, sem rede, GitHub, credenciais, modelo, VM, systemd, sudo ou instalação de pacotes. Registros: `32-real-{build,verify,install,setup,doctor,controller-refusal}-2026-11-14.json`.

| Fase | Observado |
|---|---|
| build | `RELEASE_BUILT mvp-32.1`, arquivo `software-factory-mvp-32.1.tar` sha256 `c9f3f744…`, manifest `7ccfd824…`, 23 529 entradas, assets34 pin `8efa506a…` conforme |
| verify | sha do arquivo = sidecar = relatório; manifest confere; 23 542 entradas listadas, **0 violações** (sem caminhos absolutos/`..`, tudo sob `factory/`, `releases/<id>/`, `assets/guest/<sha>/`) |
| install | extração criou só `assets`, `factory`, `releases` |
| setup (2×) | 1ª criou `config.yaml` e 4 diretórios; **2ª criou `[]`**; release/assets intactos |
| doctor | `INVALID_CONFIGURATION` (configuração de exemplo incompleta, como esperado), com release e versões detectadas pelo Node privado |
| controller-refusal | exit 2 `CONFIGURATION_INVALID` **antes** de storage: sem `data/control.sqlite` e sem `run/factory.sock` |

Nenhuma credencial foi lida (`credentials/` ficou vazio) e nada fora de `r32-v1` foi escrito.
