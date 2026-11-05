# Controlador exclusivo e pausa durável — ticket 02

Autoridade: [ticket 02](../.scratch/software-factory-mvp/issues/02-exclusive-controller-and-durable-pause.md),
[spec §§3.1/3.4/5.1/5.2/11.3/13.4](../.scratch/software-factory/spec.md),
[interfaces Q3/Q7/Q13](../.scratch/software-factory/module-public-interfaces.md),
[cenários V-01/V-11](../.scratch/software-factory/acceptance-and-incremental-plan.md).

## Incremento e operação

Depois de `npm ci && npm run build`, `./factory setup --root <instalação>` prepara
paths, mas seu exemplo incompleto **não permite `run`**. Preencher configuração
completa explícita conforme o contrato existente; não há repos/modelos/credenciais
herdados. `run` valida o YAML inteiro pela implementação existente, sem iniciar VM,
consultar GitHub ou carregar credenciais. Os testes usam configuração sintética
válida, com `repositories: []`, modelos não utilizados e arquivo de chave que nunca
é aberto. Não é evidência de integração com esses componentes.

```sh
./factory run --root <instalação>
./factory status --root <instalação> --json
./factory pause --request-id <id-estável> --root <instalação> --json
./factory request <id-estável> --root <instalação> --json
./factory unpause --request-id <outro-id> --root <instalação> --json
```

A identidade é impressa em stderr antes do envio; stdout contém somente o resultado.
`durable` significa commit confirmado, não início de trabalho/efeito. Mesmo ID e
operação retornam o recibo original; operação diferente com mesmo ID é recusa.
Depois de conexão perdida, consultar/repetir **a mesma identidade e conteúdo**.
Não localizado não comprova ausência de outro ingresso equivalente.
Indisponibilidade é erro explícito (consulta: exit 3; mutação indeterminada: exit 4),
nunca leitura offline do banco, lista vazia ou sucesso. Entrada inválida/recusa: exit 2.
Segundo proprietário: exit 73, sem takeover, remoção ou substituição do lock.

O launcher resolve a raiz canônica, rejeita symlinks nos paths internos e hardlinks
nos arquivos de controle, usa lock estável `data/control.lock` e executa
`flock --exclusive --nonblock --no-fork`. O proprietário interno verifica via
`/proc/locks` seu PID e dispositivo/inode antes de abrir SQLite. Isso é suporte
Linux, não fallback portátil nem autenticação contra código host comprometido.
O socket fica em `run/control.sock`, diretório 0700/socket 0600. Socket obsoleto
próprio só é removido após exclusividade; arquivo regular/desconhecido não é removido.
Os subprocessos usam o padrão Node sem repasse do descritor de lock.

`Control.accept`, `inspect` e `run` são a única superfície da instância; Session,
adapter e SQL não são exportados. Os documentos Session `factory.installation` e
`factory.request` guardam pausa/histórico e ingresso/recibo. Commits normais unem
todos esses fatos; não há CRUD de domínio próprio, fila de ingressos ou segundo motor.

### Barreira neste incremento sem Execuções

A barreira já está fechada antes de abrir Session e **nunca abre neste incremento**.
`run` consulta o inventário persistido real de tarefas com `Session.commit/tx.scanTasks`;
o bootstrap inspeciona `environments/` e entradas desconhecidas em `run/`.
Somente inventário de tarefas vazio **e** ausência de recursos próprios desconhecidos
permitem a razão `EXECUTION_NOT_ENABLED`, que ainda significa despacho **fechado**.
Qualquer inventário não vazio/desconhecido mantém `RECONCILIATION_REQUIRED`.
`unpause` só altera pausa persistida; não concede autoridade de execução.

Não há chamadas a Harness.resume/submit/wait, tasks executáveis, Builder ou efeitos
externos neste incremento, nem um falso scheduler para simulá-los. A integração usa
a API pública real `createSession`, `defineDoc`, `defineDocFamily`, `commit`,
`snapshot`, `scanTasks`, `close` e `closed`. Nenhuma API de scheduler bruto é exposta.
Os próximos tickets que introduzirem fases/efeitos devem instalar e provar a guarda
de autoridade vigente em **cada** caminho, inclusive resume/submit/waits, antes de
liberar despacho. Os testes atuais não são prova desses caminhos futuros,
reconciliação de VMs/sobreviventes de Builder ou do MVP inteiro.

## Persistência e dependências verificadas

- `@earendil-works/pi-durable@1.5.0`, `@earendil-works/chord@1.5.0`, Node 24.21.0,
  npm 11.19.0, TypeScript 6.0.3; integridades/transitivas em `package-lock.json`.
- `openNodeSqliteDatabase` público configura inicialmente WAL/NORMAL. Antes de
  `SqliteStorage.open`/qualquer commit Session, o mesmo adapter recebe
  `PRAGMA synchronous=FULL`; leituras reais verificam WAL e synchronous=2.
  Adapter/conexão permanecem privados; não há outro setter de PRAGMA na aplicação.
- `sqlite_version()` observado: **3.53.4**. `sqlite_source_id()` observado:
  `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`.
  Abertura recusa versões abaixo de 3.51.3; este perfil não promete backports não
  verificados. O [aviso oficial WAL-reset](https://sqlite.org/wal.html#walreset)
  identifica a correção em 3.51.3+; metadados do binding sozinhos não foram usados.
- Status apresenta essa verificação do owner real. Os testes verificam versão/source
  literais e política WAL/FULL; não substituem SQLite nem inferem FULL pelo nome do pacote.
- FULL não prova resistência de hardware/filesystem, falha de energia/host, backup,
  fs defeituoso ou SLA. Só storage temporário local foi usado.

### Compatibilidade de declarações upstream — exceção explícita aprovada

O primeiro build/typecheck com `skipLibCheck` desligado encontrou **12 TS2344** em
`@earendil-works/chord@1.5.0/dist/next/contracts/evolve.d.ts`, linhas
10, 11, 12, 13, 17, 18, 19, 20, 24, 25, 26, 27: os tipos mapeados `Put`/`Drop`
não satisfazem `Variants` com `exactOptionalPropertyTypes` (propriedade opcional
`keyed` pode ser undefined). Também houve **TS2307** em
`@google/genai@2.21.0/dist/node/node.d.ts:1`, import de tipo de
`@modelcontextprotocol/sdk/client/index.js`, peer opcional declarado `^1.25.2`.

O supervisor aprovou explicitamente **`skipLibCheck: true` somente para checagem de
declarações de terceiros**, mantendo `strict`, `exactOptionalPropertyTypes`, todos
os fontes/testes autorais, resolução e gate arquitetural. Nenhum vendor patch,
`any`, `ts-ignore`, mudança de API ou substituto de runtime foi usado.
Não se afirma que as declarações upstream sejam limpas. O peer MCP não foi
adicionado: é referência de tipo opcional na biblioteca de provedor não usada;
nenhum MCP runtime/ferramenta/modelo é inicializado. O teste de importação pública
sob permissões restritas passa sem escrita, subprocesso, SQLite aberto ou perfil pessoal.
`typecheck-gate.test.ts` usa fixture inválida temporária e verifica TS2322 e TS2375,
provando que erros de fontes e opcionalidade exata continuam reprovando.

A única correção arquitetural permite o bootstrap de configuração existente ao
entrypoint controller, já previsto em Q13. Fixture positiva e negativas de
worker/deep import preservam a fronteira; nenhuma aresta entre módulos foi liberada.

`npm ci` reporta 5 vulnerabilidades moderadas (mesma contagem da baseline antes
adicionar Durable) e scripts de instalação não aprovados em genai/protobufjs.
Não foram usados audit fix forçado, instalação de pacotes do sistema ou comandos
`npm install-scripts approve`. Esses avisos não são declaração de segurança da release.

## Evidência reproduzível no menor nível fiel

Todas as linhas abaixo são **I — integração real local**, salvo as fixtures
estáticas de arquitetura/tipos. Não há dublê de Controle, domínio, SQLite,
protocolo, scheduler, processo ou lock. A fixture IPC apenas chama as operações
públicas reais dentro de um subprocesso sob flock; não substitui persistência.

| Subcaso V-01/V-11 | Expectativa e observado | Fonte |
| --- | --- | --- |
| Pausa/reinício limpo | Recibo durável, pausa e uma entrada de histórico preservados; reenvio recupera o mesmo recibo; unpause não libera despacho | `controller.test.ts` |
| Exclusividade/aliases | Mesmo path, alias symlink da raiz e path normalizado recusam segundo proprietário; inode do lock permanece; owner interno sem flock recusa abertura | `controller-ownership.test.ts` |
| Crash de processo | SIGKILL somente no owner temporário; novo processo adquire lock, recupera pausa confirmada e continua com despacho fechado | `controller-ownership.test.ts` |
| Falha de commit | `prlimit --fsize=0:0` **somente no PID temporário** impede escrita SQLite; nenhuma confirmação durável; saída não limpa; reabertura mostra pausa/histórico/pedido sem transição parcial | `controller-ownership.test.ts` |
| Descritor não herdado | Subprocesso Node real permanece vivo após SIGKILL do dono flock; outro flock adquire o mesmo arquivo antes de matar esse filho de teste | `control-public.test.ts`, `control-fixture.ts` |
| ACK perdido | Socket real é fechado após envio, sem ler ACK; proprietário permanece consultável, resultado conhecido é recuperado | `controller-ingress.test.ts` |
| Duplicação/conflito | Oito conexões concorrentes reapresentam o ID; uma entrada de histórico; conteúdo diferente recusa; mensagem de abertura antiga/origem worker não altera pausa | `controller-ingress.test.ts` |
| Barreira | Antes de run: closed/reconciliação; depois do inventário vazio e unpause: ainda closed; recursos desconhecidos tanto em environments quanto run permanecem preservados e impedem classificação vazia | `control-public.test.ts`, `controller-ownership.test.ts` |
| Config inválida/offline | Template incompleto não abre DB; consulta offline sai com erro explícito, não acessa banco | `controller-ownership.test.ts` |
| Frames | UTF-8 fragmentado byte a byte e frames coalescidos; nenhum despacho antes da linha; versão/campos/UTF-8/EOF parcial/limite inválidos entregam erro ao handler, nunca mensagem válida | `protocol.test.ts` |
| Transporte versus commit | send resolve sem recibo fabricado; só o owner pode devolver durable depois do commit | `protocol.test.ts`, `controller-ingress.test.ts` |

Limites do perfil de transporte: versão 1, frame 64 KiB, fila pendente 256 KiB;
excesso falha/fecha explicitamente, sem truncamento ou replay automático.
Timeout de consulta CLI não é timeout de Execução, detecção de morte ou heartbeat.

### Red/green e comandos

Slices observados antes da correção:
1. Pausa/reinício: RED `run` saía 2, depois falha na repetição ao devolver Draft
   fora da transação; GREEN com Session real e recibo destacado antes de resolver.
2. Perda de ACK: RED owner morria por confundir erro de envio com persistência;
   GREEN separando commit de entrega da resposta.
3. Framing: RED de compilação na seam de notificação de fechamento/erro;
   GREEN com handler `message/closed` e parser real limitado.
4. Config/bootstrap: RED run aceitava template incompleto e fixture positiva era
   recusada pelo gate; GREEN validação antes de SQLite e correção estreita de Q13.
5. Inventário desconhecido em run: RED era classificado vazio;
   GREEN com inventário real das duas áreas.

Testes de lock, SIGKILL, limite de arquivo e policy SQLite foram acrescentados como
provas reais de regressão da composição, já verdes; não são apresentados como
slices RED anteriores que não aconteceram.

```sh
export PATH=/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin:$PATH
timeout 120s npm ci
timeout 90s npm test
timeout 30s npm run typecheck
git diff --check
```

Suíte local completa observada: **45/45** testes, nenhum skipped, em ~14 segundos
(runtime de testes; arquitetura/build são etapas adicionais). A revisão independente
continua sendo o gate do supervisor; estes resultados não integram esta branch
nem aprovam o piloto/release. Nenhum storage de produção, serviço instalado,
credencial real, modelo, GitHub mutável ou sistema preexistente sofreu injeção de falha.
