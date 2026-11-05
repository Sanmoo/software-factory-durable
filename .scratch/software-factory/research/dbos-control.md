# Pesquisa: DBOS como controle durável local da fábrica

Consulta: **2026-11-03**. Pesquisa documental do [ticket](../issues/12-dbos-control-research.md), para a [decisão de durabilidade](../issues/02-durability-strategy.md) e sua [matriz](../durability-comparison.md). Autoridade: [PRD](../prd.md), especialmente RF-01/03/04/10/12/13, RNF-01 e CA-06. **Não escolhe tecnologia, linguagem ou runtime; não demonstra conformidade ponta a ponta.**

## Resumo e recorte

DBOS oferece controle além de sessões de agentes: workflows, passos, transações, mensagens e filas duráveis. A composição TypeScript autônoma é aplicação Node + SDK + PostgreSQL, sem Conductor obrigatório. Porém fila de workflows não equivale à fila/Slot do produto, e ownership de checkpoints não impede escritores externos concorrentes: identidade permanente, seleção elegível, supervisão e reconciliação GitHub continuam próprias. [S1–S9]

Legenda: **D** = documentação/código estático; **H** = hipótese de composição; **?** = desconhecido. Confiança alta nas APIs verificadas, média no encaixe conceitual. Não foram instalados/executados SDKs, serviços, modelos ou testes.

**D. Versões:** API oficial informou TS **v5.4**, publicada em 2026-10-28, tag resolvida para `a70b65f93e5cf282014b7606a9db91b00231d753`; Python **3.4.0**, mesma data, SHA `718d06613d9b7dc4c935e098e4608b6745267760`. A inspeção principal usa snapshots posteriores: TS **`54f3eb4fe1618cd3019384c74baabf7c815949c9`** e Python **`232dd751576b7d350a3614ad4ef7fc786eb282ff`**, ambos de 2026-11-02. Não são versões publicadas. TS `package.json` contém `0.0.0-placeholder`, não versão npm utilizável. Docs são móveis, não necessariamente correspondentes às tags. [S10–S12]

## 1. Composição mínima e licença

**D.** TS exige Node **>=20** e PostgreSQL; não foi identificado suporte SQLite nesse SDK. Os LICENSE dos dois SDKs são **MIT**. Enterprise é peer opcional TS e extensão comercial não open source, sob Conductor Software License. Conexão ao Conductor exige essa extensão, não o recovery single-server. A licença comercial consultada, atualizada em dezembro/2025, distingue teste/desenvolvimento de produção, exige chave válida em produção e prevê verificação de licença; não é uma licença MIT. Preço e parecer jurídico não foram apurados. [S1, S6, S10–S13]

| Dependência / papel | O que elimina ou fornece | O que permanece próprio |
| --- | --- | --- |
| TS: Node + `@dbos-inc/dbos-sdk` | Replay, checkpoints, mensagens, despacho e inspeção de workflows | Domínio do Trabalho, polling GitHub, CLI, integração do builder |
| TS: PostgreSQL persistente | Histórico e filas; pode hospedar tabelas da fábrica | Backup/restore, migrations, retenção e invariantes SQL |
| TS: datasource, se necessário | Transação de aplicação com checkpoint atômico; pacote separado | Escolher binding, isolamento, constraints/transições; não exige outro servidor |
| Python: Python >=3.10 + `dbos` + SQLite | Workflows sem serviço PostgreSQL obrigatório; SQLAlchemy/psycopg são dependências | Controle de domínio; validar durabilidade/backup do arquivo |
| Python: datasource SQLAlchemy | Transações rastreadas SQLite/PostgreSQL; async SQLite requer `aiosqlite` | Migrations/invariantes; não transportar APIs TS automaticamente |
| Ambos: supervisor + runtime de coding + artefatos | Não são substituídos pelo SDK | Processos, worktrees, sessões, credenciais e reconciliação |
| Opcional: Conductor/Enterprise, telemetria, frontend HTTP | Controle remoto/recovery distribuído; Enterprise anuncia sharding, retenção, auto-upgrade | Licença/operação adicionais; não necessários ao núcleo local |

Dependências são **D**; distribuição das responsabilidades é **H**, não desenho aprovado. Python usa SQLite por padrão, com PostgreSQL recomendado para produção. `SQLAlchemyDatasource`/`AsyncSQLAlchemyDatasource` suportam ambos. Menos serviços não prova menor complexidade total: `synchronous`/WAL e restauração Python não foram auditados. [S4, S6, S12–S15]

## 2. Checkpoints, transações e autoridade

**D.** `registerWorkflow`, `startWorkflow`, `runStep` e `registerStep` dividem execução em unidades serializáveis. Recovery reexecuta a função reutilizando resultados persistidos; o workflow deve chamar passos deterministicamente, na mesma ordem, dados seus resultados anteriores. Tempo, aleatoriedade, filesystem e rede pertencem aos passos. Envolver um agente inteiro em um passo **não checkpointa seu interior**. [S2, S3]

**D.** Passos têm garantia **at-least-once**, sem repetição após resultado registrado; transações de datasource fazem commit **exactly-once**. `runTransaction`/`registerTransaction` usa o cliente transacional do datasource e registra `transaction_completion` junto às mudanças da aplicação. O código node-postgres mostra `BEGIN`, execução/registro, `COMMIT` e rollback em falha. Git/GitHub/modelos não participam dessa transação. [S4, S16]

**H, CA-06.** Push, PR ou pergunta podem ter sucesso antes do checkpoint; o passo pode repetir. A fábrica precisa de intenção/identificador estável e descoberta do resultado remoto antes de nova tentativa. Deve reconhecer mudança humana, preservar o SHA esperado do lease e bloquear identidade ambígua, não renovar a expectativa automaticamente. Checkpoint evita repetição **conhecida**, não resolve resultado remoto desconhecido. [S2–S4; PRD RNF-01/CA-06/09]

**D/H.** `workflowID` estável é chave idempotente; chamadas repetidas normalmente retornam handle existente. Deduplicação da fila só vale enquanto `ENQUEUED`, `DELAYED` ou `PENDING`; término libera o dedup ID. Singleton `return-existing` descarta argumentos novos. RF-01 ainda exige identidade permanente/tombstone de entrega ou cancelamento, retenção adequada e consolidação própria do contexto de eventos. [S2, S5]

**H.** Uma autoridade SQL de domínio no mesmo PostgreSQL poderia guardar ticket único, admissão original, categoria/elegibilidade, reserva de Slot, pergunta/resposta, contadores e intenções. Constraints/transações próprias podem validar juntos unicidade, capacidade e transições; DBOS executaria essas regras, não as fornece prontas. Isso evita supor dois controladores com autoridades concorrentes. [S4, S7]

**D/H.** PostgreSQL DBOS expõe **`dbos.enqueue_workflow(...)`** e **`dbos.send_message(...)`**, esta com `message_id` idempotente, chamáveis por trigger/procedure na **mesma base**. Alteração própria + enqueue/envio podem compartilhar uma transação SQL externa (**inferência de composição**, não implementação validada). Datasource une alteração própria + seu checkpoint. A chamada normal `startWorkflow` não expõe transação SQL ambiente do domínio; iniciar/enfileirar workflow dentro de step/transação é recusado. Alternativa é intenção persistida e despacho reconciliável por IDs estáveis. Mesmo servidor não significa mesma base/transação. [S3, S7, S20]

**?** Não foi demonstrado commit único de reserva própria + toda seleção e dequeue interno DBOS. Evitar tratar escrita manual de tabelas internas como API. Migrations de domínio, privilégios, backup consistente de estado/artefatos e protocolo de troca de sessão continuam próprios. [S4, S7]

## 3. Filas, FIFO, prioridade e Slots

**D.** `registerQueue` persiste configuração; `startWorkflow(...,{queueName, enqueueOptions:{priority}})` enfileira. Menor número vence, default **0**, maior prioridade. Empates são dequeued FIFO, não necessariamente concluídos nessa ordem. `workerConcurrency` limita por processo; `globalConcurrency` conta `PENDING` na fila, inclusive versões antigas. Código seleciona `ORDER BY priority ASC, created_at ASC` e faz claim transacional. Setters permitem reconfigurar; novo `registerQueue` pode sobrescrever ajustes sem `onConflict:'never_update'`. [S5, S8]

**H.** Fila de ativações com prioridade reparo/normal aproxima RF-03 sem preempção; revisores podem ser passos/filhos sem novos Slots. Mas `recv`/`sleep` em workflow `PENDING` não libera automaticamente sua concorrência global. Duas filas independentes tampouco entregam sozinhas orçamento global e preferência absoluta por reparos. [S2, S5, S8]

**H/?** Separar ciclo do Trabalho de ativações limitadas à duração do builder permite esperas fora da capacidade, exigindo ligação/estado e despacho próprios. Nova ativação recebe novo `created_at`, não necessariamente a ordem original de admissão. Não foi encontrada opção pública para fornecer essa ordem, nem predicado GitHub para pular inelegíveis preservando-a. Isso pede seleção persistente própria ou protocolo validado; não basta citar FIFO DBOS como cumprimento de RF-03. [S5, S8]

## 4. Recovery, espera, retry e cancelamento

**D.** Single-server sem Conductor recupera `PENDING` após restart, respeitando versão. Múltiplos executores exigem gestão de IDs/recovery. A documentação admite executor zumbi concorrente: ownership token é verificado na transação de checkpoint; quem perdeu ownership para e aguarda resultado vencedor. **Não é mutex vitalício de processo externo.** [S6, S9, S18]

**H, RF-04/CA-06.** Antes de lançar substituto, é preciso identificar builder sobrevivente e seu ambiente/proprietário, recuperar supervisão ou confirmar encerramento. Token SQL protege estado DBOS, não escrita do zumbi em worktree/GitHub. Isso vale mesmo single-host se filhos sobrevivem ao controlador. [S9; PRD RF-04]

**D/H.** `send` persiste mensagens; dentro de workflow entrega é exactly-once; fora aceita `idempotencyKey`. `recv` consome FIFO por tópico com timeout default **60 segundos**. Timeout não deve virar cancelamento do Trabalho. Pergunta/publicação, autorização e correlação são próprias: mensagem durável não autentica operador GitHub. Referência atual usa `RecvOptions`, tutorial mostra número; código aceita ambos. [S17, S19, S20]

**D, somente snapshot.** API TS e `tests/suspend.test.ts` declaram `recv(...,{suspend:true})`/`sleep(...,{suspend:true})` **Enterprise**, exigindo `suspendMode`: estacionam no banco, saem da execução e reenfileiram ao despertar. Teste público verifica recusa sem Enterprise; não foi executado. Não atribuir isso automaticamente à release v5.4 nem supor que resolva ordem/Slots do produto. Espera core continua possível, inclusive composta fora da fila de ativações. [S20]

**D/H.** Steps oferecem `retriesAllowed` (default false), `maxAttempts` (inclui primeira tentativa), `intervalSeconds`, `backoffRate` e `shouldRetry`. Exceção não tratada produz `ERROR`, sem recovery automático. RF-13 ainda requer contadores persistentes separados para reparo/retomada, classificação de falhas e bloqueio visível; defaults SDK não equivalem aos limites do produto. [S2, S3]

**D/H.** `cancelWorkflow` persiste `CANCELLED`, mas não mata passo corrente: ele pode observar `stepStatus.cancelSignal`. Timeout de step é cooperativo; operação que ignora sinal pode continuar em background. Timeout de workflow é início-a-conclusão, não orçamento de builder excluindo esperas. `resumeWorkflow` sem `queueName` pode contornar fila. A CLI precisa restringir retomadas; interrupção de processos, barreira de publicação e reconciliação do efeito já enviado seguem próprias. [S3, S19]

## 5. Update com parada controlada

**D.** Versão deriva de hash do código ou `applicationVersion`; recovery exige correspondência. Mudança de sequência/passos pode invalidar replay. `patch`/`deprecatePatch` preserva caminhos antigos/novos e só pode ser removido após drenar históricos pertinentes. Auto-upgrade é Enterprise, exige mudanças patched e não migra arbitrariamente semântica/contexto. [S18]

**H.** Q2 permite parar admissão, drenar/interromper com confirmação, fazer backup/migrar e reconciliar. Dispensa rolling update, **não** compatibilidade de perguntas pendentes: manter replay compatível no novo binário, preservar versão antiga para retomada controlada ou migrar explicitamente Trabalho/contexto. Novo builder pode substituir sessão incompatível, mas deve preservar pergunta/resposta, categoria, admissão, limites e intenções. Espera não exige processo antigo vivo; manter código/serializadores antigos ou escrever migração ainda custa manutenção. Não foi encontrado conversor automático de contexto do coding runtime nem garantia de migração arbitrária. [S18; PRD RNF-01; Q2]

## Contradições, lacunas e validação

- Busca genérica sugeriu SQLite TS: rejeitado pelos guias específicos/código. Python tem SQLite. Índice indicava v5.2; API oficial informou v5.4. “Executa uma vez” é delimitado pela documentação de zumbis. Assinatura `recv` e suspensão mostram diferenças entre tutorial, referência e snapshot. [S1, S9–S15, S19–S20]
- **?** Pendentes: seleção elegível/FIFO original sem autoridade duplicada; configurações SQLite/backup; paridade release/snapshot; limites de recovery versus contadores; migração de schema/contexto e protocolo do supervisor. Ausência de evidência não prova impossibilidade.
- Provas futuras, não autorizadas: crash com builder sobrevivente; efeitos GitHub sem confirmação; espera liberando Slot e retomando ordem; cancelamento real; restore/update incompatível. Sem benchmarks ou estimativas de LOC/tempo.
- Originais foram abertos/cruzados com código por SHA. Duas chamadas `source_check` retornaram passagens, porém avaliação semântica automática indisponível (`unclear`); revisão manual dos originais, não aprovação automatizada.
- Links relativos conferidos documentalmente: três destinos `../` lidos e PRD em `../../../tecnologia/`. Único arquivo de repositório criado: este. **Sem shell nesta sessão:** diff/check incluindo arquivo novo, escopo, commit, push SSH BatchMode e `ls-remote` pendentes do supervisor, conforme divisão explícita de responsabilidade. Não declarar resolução/publicação antes disso.

## Fontes

Consultadas em 2026-11-03; docs móveis, código fixado. Resultados de busca/índices e URLs 404 foram apenas descoberta ou descartados.

- **S1** [Guia TS](https://docs.dbos.dev/typescript/programming-guide) — composição e Conductor.
- **S2** [Workflows](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial) — determinismo/garantias.
- **S3** [Steps](https://docs.dbos.dev/typescript/tutorials/step-tutorial) — retry/timeout.
- **S4** [Transactions TS](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial) — atomicidade.
- **S5** [Queues](https://docs.dbos.dev/typescript/tutorials/queue-tutorial) — prioridade/concorrência.
- **S6** [Recovery](https://docs.dbos.dev/production/workflow-recovery) — autonomia local.
- **S7** [System database](https://docs.dbos.dev/explanations/system-tables) — funções SQL.
- **S8** [SystemDatabase fixado](https://github.com/dbos-inc/dbos-transact-ts/blob/54f3eb4fe1618cd3019384c74baabf7c815949c9/src/system_database.ts) — seleção/ownership.
- **S9** [Concurrent executions](https://docs.dbos.dev/explanations/concurrent-executions) — zumbis.
- **S10** [Package TS](https://github.com/dbos-inc/dbos-transact-ts/blob/54f3eb4fe1618cd3019384c74baabf7c815949c9/package.json), [LICENSE TS](https://github.com/dbos-inc/dbos-transact-ts/blob/54f3eb4fe1618cd3019384c74baabf7c815949c9/LICENSE) — dependências/MIT.
- **S11** [Release TS v5.4](https://github.com/dbos-inc/dbos-transact-ts/releases/tag/v5.4), [tag resolvida](https://github.com/dbos-inc/dbos-transact-ts/commit/a70b65f93e5cf282014b7606a9db91b00231d753), [snapshot](https://github.com/dbos-inc/dbos-transact-ts/commit/54f3eb4fe1618cd3019384c74baabf7c815949c9) — versões/datas.
- **S12** [Release Python 3.4.0](https://github.com/dbos-inc/dbos-transact-py/releases/tag/3.4.0), [tag resolvida](https://github.com/dbos-inc/dbos-transact-py/commit/718d06613d9b7dc4c935e098e4608b6745267760), [snapshot](https://github.com/dbos-inc/dbos-transact-py/commit/232dd751576b7d350a3614ad4ef7fc786eb282ff), [pyproject](https://github.com/dbos-inc/dbos-transact-py/blob/232dd751576b7d350a3614ad4ef7fc786eb282ff/pyproject.toml), [LICENSE](https://github.com/dbos-inc/dbos-transact-py/blob/232dd751576b7d350a3614ad4ef7fc786eb282ff/LICENSE) — versões/dependências/MIT.
- **S13** [Enterprise](https://docs.dbos.dev/explanations/transact-enterprise), [licença Conductor](https://www.dbos.dev/conductor-license) — fronteira comercial.
- **S14** [Guia Python](https://docs.dbos.dev/python/programming-guide) — SQLite default.
- **S15** [Transactions Python](https://docs.dbos.dev/python/tutorials/transaction-tutorial) — SQLAlchemy/SQLite.
- **S16** [Datasource node-postgres](https://github.com/dbos-inc/dbos-transact-ts/blob/54f3eb4fe1618cd3019384c74baabf7c815949c9/packages/nodepg-datasource/index.ts) — commit/checkpoint.
- **S17** [Comunicação](https://docs.dbos.dev/typescript/tutorials/workflow-communication) — mensagens/eventos.
- **S18** [Upgrading workflows](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows) — versões/patches.
- **S19** [Methods](https://docs.dbos.dev/typescript/reference/methods) — cancel/resume/recv.
- **S20** [API TS](https://github.com/dbos-inc/dbos-transact-ts/blob/54f3eb4fe1618cd3019384c74baabf7c815949c9/src/dbos.ts), [teste estático de suspensão](https://github.com/dbos-inc/dbos-transact-ts/blob/54f3eb4fe1618cd3019384c74baabf7c815949c9/tests/suspend.test.ts), [enqueue](https://github.com/dbos-inc/dbos-transact-ts/blob/54f3eb4fe1618cd3019384c74baabf7c815949c9/src/enqueue_workflow.ts) — diferenças snapshot/docs e transições proibidas.

## Próximo passo

Supervisor verificar evidências/tamanho/escopo e publicação exclusiva da branch de pesquisa; usar lacunas na comparação, sem escolher tecnologia por este relatório. Provas executáveis exigem autorização separada.
