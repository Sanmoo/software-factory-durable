# Pesquisa: base transacional de um controlador próprio local

## Resumo e recorte

SQLite fornece transações para construir uma autoridade local de estado, não um controlador durável pronto. A alternativa concreta é um controlador de domínio que persiste admissão, filas, reservas e intenções antes dos efeitos, aplica resultados em transações curtas e consulta pendências ao reiniciar. Sua viabilidade documental não demonstra CA-06 nem menor complexidade total; concorrência de processos, publicação e reconciliação continuam sendo código da fábrica. [S1–S4; P]

Pesquisa documental da rodada de **2026-11-03**, sem executar SQLite, modelos, serviços ou provas. Referência de biblioteca publicada encontrada: **SQLite 3.54.1, 2026-10-16**, source ID `555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76`; não é versão instalada/verificada neste host. Documentação oficial é móvel: Isolation registra atualização 2022-04-18; Transaction, 2026-02-18; WAL, 2026-08-25. Não escolher linguagem/binding: sua versão, SQLite efetivamente embarcado e opções de compilação permanecem desconhecidos. [S2–S4; S12]

Legenda: **D** = evidência direta oficial; **H** = hipótese/inferência de composição, não capacidade pronta. Confiança alta nas propriedades documentadas condicionais; média na composição conceitual, ainda não testada. Autoridade de produto: [PRD][P]; comparação sem vencedor no [ticket decisório][T] e na [matriz][M].

## 1. Garantias do banco e seus limites

**D — ACID.** SQLite declara transações atômicas, consistentes, isoladas e duráveis, inclusive sob interrupção. Isso significa tudo ou nada dentro da transação, não correção automática das regras da fábrica. A declaração geral deve ser lida com as condições de journal, sincronização e armazenamento abaixo: não autoriza dizer que qualquer configuração preserva todo commit em qualquer falha. [S1; S5; S6]

**D — conexões/processos.** Há múltiplos leitores, mas apenas uma transação de escrita simultânea por banco. Conexões distintas, inclusive em processos diferentes, não veem mudanças não commitadas; exceção: shared cache junto com `read_uncommitted`. SQLite serializa escritas; WAL permite leitores em snapshots concorrendo com um escritor, não múltiplos escritores simultâneos. Na mesma conexão não existe esse isolamento entre operações; compartilhar uma conexão exige coordenação da aplicação. [S2; S3]

**D — transações e BUSY.** `BEGIN DEFERRED` pode começar como leitura e falhar ao promover para escrita. `BEGIN IMMEDIATE` tenta obter a transação de escrita antecipadamente, podendo retornar `SQLITE_BUSY`; snapshot antigo em WAL pode gerar `SQLITE_BUSY_SNAPSHOT`, exigindo encerrar e reiniciar a transação. `COMMIT` também pode retornar BUSY e, no caso documentado, manter a transação ativa. `busy_timeout` espera até seu orçamento, depois devolve BUSY: não é fila FIFO de produto nem garantia de progresso. Erros de I/O, espaço e memória podem desfazer uma instrução ou toda a transação; tratamento deve verificar o estado, não supor commit. [S2; S3; S7]

**H — uso concreto.** Serializar mutações de domínio em transações curtas no mesmo banco permite ler elegibilidade conhecida/Slots, selecionar categoria/ordem e reservar conjuntamente. Consultas GitHub, spawn, execução do agente e espera humana ficam fora da transação. Revalidar autorização/dependências antes do despacho continua necessário: uma observação persistida não torna o GitHub estático. Repetir uma transação abortada não autoriza repetir um efeito externo. [S2–S3; P, RF-02–04]

### Configuração e falhas diferentes

| Configuração documentada | Crash somente do processo | Crash do sistema/host ou energia |
| --- | --- | --- |
| WAL + `synchronous=FULL` | Commits preservados nas condições documentadas. | Sync adicional do WAL a cada commit fornece durabilidade, condicionado ao funcionamento de OS/FS/hardware. |
| WAL + `synchronous=NORMAL` | Commits preservados. | Mantém consistência/atomicidade, mas commits podem ser revertidos após recuperação. |
| `synchronous=OFF` | A documentação distingue a segurança frente a crash da aplicação. | Pode haver corrupção, não apenas perda de commits. |
| Rollback journal + FULL/EXTRA | Recuperação usa journal, não o mecanismo WAL. | FULL pode não garantir durabilidade conforme o FS; EXTRA sincroniza também o diretório após unlink do journal em DELETE. Em WAL, EXTRA não acrescenta garantia a FULL. |

**D:** tabela baseada em `PRAGMA synchronous`; journal desativado não é alternativa equivalente segura. `fsync`/`xSync` precisam cumprir o contrato; sincronização não protege de armazenamento defeituoso que minta sobre persistência. **H:** uma perda de commit de intenção pode esconder um efeito remoto já aplicado; a recuperação não deve presumir ausência remota apenas pela ausência local. O PRD não fixa SLA, RPO nem perda de energia como novo requisito: estas diferenças precisam de decisão explícita, sem escolher a política nesta pesquisa. [S3–S6; P, RNF-01]

**D — persistência operacional.** WAL exige processos no mesmo host e não funciona em filesystem de rede. O arquivo `-wal` integra o estado persistente; separá-lo do banco pode perder transações/corromper dados; `-shm` participa da coordenação. Checkpoints transferem conteúdo ao banco; leitores longos podem impedir sua conclusão e favorecer crescimento do WAL. WAL não elimina BUSY, inclusive em recuperação/fechamento. Não tratar checkpoint como confirmação de negócio nem apagar auxiliares manualmente. Locks e flushes corretos do FS, permissões do diretório e espaço disponível integram a operação. [S4; S6; S13]

**D — correção relevante.** O aviso oficial WAL-reset descreve corrupção rara com duas ou mais conexões concorrendo em escrita/checkpoint: versões 3.7.0–3.51.2 provavelmente afetadas; correção em **3.51.3 (2026-03-13)** e posteriores, com backports 3.44.6/3.50.7. Isso exige verificar a biblioteca real do binding, não apenas seu nome/versão. Não quantificamos risco nem assumimos que serialização de domínio dispense a correção. [S4, §11]

## 2. Alternativa própria mínima: responsabilidades e cortes

**H — composição comparável.** Uma autoridade de controle persiste identidade do ticket/Trabalho, autorização e versão da especificação; ordem/categoria; Execução e reserva de Slot; branch/worktree/contexto; pergunta/resposta/publicação; contadores separados de reparos e retomadas; última fase confirmada e intenções pendentes correlacionadas. Restrições e transações do banco sustentam invariantes locais; o controlador define quais transições são legais. Isso não requer DSL, motor genérico, event sourcing obrigatório, broker ou plugins. Sessões e arquivos são referências/contexto, não autoridades concorrentes. [S1–S3; P, RF-01/03/10/13, RNF-01/05; M]

A tabela é **H**, derivada de CA-06 e da régua comum; não descreve mecanismo implementado. Em todas as linhas, SQLite pode atomizar apenas a coluna local. A publicação direta pelo builder já decidida no esforço permanece: registrar uma intenção não transfere publicação para o controlador. [M]

| Corte | Fronteira mínima da transação local | Efeito fora do banco e recuperação própria obrigatória |
| --- | --- | --- |
| Admissão concorrente/reinício | Identidade única; admissão/ordem/categoria; deduplicação; reserva de Execução/Slot e intenção de iniciar, antes de spawn. | Revalidar elegibilidade; despachar somente reserva confirmada. Se caiu antes/depois do spawn, descobrir se há execução real antes de substituir; não simplesmente liberar toda reserva ao boot. |
| Crash durante builder | Identidade de execução, ownership declarado, fase/contexto disponível, intenção e resultado conhecido. | Reconciliar supervisor/processos/recursos sobreviventes, branch e worktree. Identidade de processo e mecanismo de confirmação ainda precisam desenho; PID isolado não comprova propriedade. Não prometer preservar raciocínio interno. |
| Push aplicado sem confirmação | Intenção correlacionada à execução, branch, commit proposto e referência remota esperada; depois, resultado observado. | Descobrir ref/commit efetivos e mudanças humanas antes de repetir. Preservar expectativa de lease; divergência bloqueia, não permite renovar lease às cegas. |
| PR criado sem confirmação | Intenção/identidade estável e correlação Trabalho–branch; depois, referência/estado observado. | Descobrir PR próprio; identidade ambígua gera bloqueio visível. Commit local não torna criação no GitHub exatamente uma vez. |
| Pergunta publicada sem confirmação | Pergunta/identificador/contexto e intenção; resultado de publicação; transição para espera e ajuste coerente da reserva. | Descobrir publicação pelo identificador antes de reenviar; suspender/confirmar que builder não permanece escritor antes de disponibilizar capacidade para substituição. Espera confirmada não ocupa Slot. |
| Resposta, retries e cancelamento | Aceitar resposta autorizada/correlacionada uma vez; reenfileirar preservando ordem/categoria; atualizar contadores e intenções de cancelamento. | Validar origem; distinguir reparo de retomada operacional, limites/backoff e falha permanente. Pedido de cancelamento não confirma interrupção: efeito já enviado pode terminar e exige reconciliação. |

**H — exclusividade real.** Um lock de escrita SQLite dura a transação do banco; depois do commit, um builder antigo pode continuar escrevendo Git/filesystem sem consultar o banco. Lease/geração persistidos ajudam a rejeitar resultados obsoletos, mas só cercam ações que efetivamente verificam essa autoridade. Para RF-04, código próprio deve confirmar propriedade/interrupção do escritor anterior e controlar lançamento/publicação; se não consegue provar exclusividade, bloquear substituição. Atomicidade local não abrange spawn, arquivos ou GitHub. Intenção pendente indica o que investigar, não prova sucesso nem fracasso externo. [S2–S4; P, RF-04/09/12, RNF-01]

**H — aplicação do resultado.** Após descobrir efeito, uma nova transação verifica identidade/execução/transição ainda válida, registra referência e fase, consolida eventos repetidos e fecha a intenção. Reinício consulta reservas, esperas e pendências antes de novos disparos. CLI, histórico, seleção FIFO com reparos prioritários, exclusão de inelegíveis, deduplicação, correlação de respostas, classificação de falhas e reconciliação são mantidos pela fábrica; SQLite não fornece essas políticas. Não há evidência para estimar LOC ou declarar essa composição mais simples que motores. [P, RF-03/10/12–13, RNF-03/05; T]

## 3. Backup, migração e dependências

**D — backup consistente.** Online Backup API fornece snapshot consistente; `VACUUM INTO` também produz cópia consistente, mas interrupção durante sua produção pode deixar destino incompleto/corrompido. Seu término e erros precisam ser verificados; não copiar apenas o arquivo principal de banco WAL ativo. Backup do banco não inclui automaticamente sessões, logs, worktrees ou objetos Git. [S4; S8; S9]

**D/H — atualização controlada.** SQLite documenta alterações de schema dentro de transações, inclusive procedimento geral com reconstrução, verificações e commit; não fornece migração semântica dos estados da fábrica. Para Q2 aprovada: pausar disparos; aguardar builders ou interromper com confirmação; preservar perguntas/esperas; produzir/verificar backup e preservar artefatos associados; migrar estado e versão de formato; verificar compatibilidade e reconciliar antes de retomar. Pergunta pendente não impede atualização. Incompatibilidade de sessão, intenção ou formato deve bloquear retomada silenciosa. Rollback do banco não desfaz efeitos remotos; restauração exige redescobri-los. Não exigir coexistência de controladores de versões diferentes. [S3; S8–S10; T]

**D — licença/dependências.** O código/documentação distribuídos de SQLite são dedicados ao domínio público; scripts de build podem ter outras licenças. A biblioteca é autocontida, com chamadas de biblioteca C e interfaces do OS via VFS, sem servidor de banco separado obrigatório. Isso não cobre licença, empacotamento, dependências nativas ou defaults do binding ainda não escolhido; tampouco elimina runtime, supervisor, migrações e suporte operacional da fábrica. [S11; S14]

## 4. Contradições, lacunas e próximos passos

Nenhuma contradição factual encontrada entre fontes mantidas. A formulação geral ACID de S1 é limitada pelas configurações descritas em S5, não justificativa para ignorá-las. `source_check` recuperou passagens sobre sincronização/licença, mas não disponibilizou avaliação semântica automática conclusiva; a validação foi leitura manual das páginas oficiais. Resumos de busca e cópias antigas da documentação não fundamentam os claims finais.

Faltam evidências empíricas: concorrência real de admissão/reserva/resposta; crash nos dois lados de spawn/push/PR/pergunta; escritor sobrevivente e interrupção confirmada; lease com alteração humana; BUSY, disco cheio e I/O; backup/restauração com artefatos; atualização com perguntas pendentes. Versão/binding, FS/VFS, sincronização por conexão e estratégia concreta de ownership/migração ainda precisam ser fixados e testados, sob autorização posterior. Próximo passo útil é usar este inventário na decisão comparativa, sem transformar pesquisa documental em aceite ou escolher vencedor. [P, CA-03/05–07/09; T; M]

## Fontes mantidas e rastreabilidade

Todos os links externos abaixo foram buscados diretamente na origem oficial nesta rodada; títulos indicam o claim sustentado. Fontes de produto locais foram lidas, sem alteração.

- [S1 — SQLite Is Transactional](https://sqlite.org/transactional.html): declaração ACID.
- [S2 — Isolation In SQLite](https://sqlite.org/isolation.html): conexões, serialização e snapshots.
- [S3 — Transaction](https://sqlite.org/lang_transaction.html): BEGIN/COMMIT, BUSY e erros.
- [S4 — Write-Ahead Logging](https://sqlite.org/wal.html): operação, arquivos, checkpoint, BUSY e correção WAL-reset.
- [S5 — PRAGMA synchronous](https://sqlite.org/pragma.html#pragma_synchronous): garantias condicionais FULL/NORMAL/OFF/EXTRA.
- [S6 — Atomic Commit](https://sqlite.org/atomiccommit.html): premissas de hardware/flush; descrição principal é rollback, não WAL.
- [S7 — Set A Busy Timeout](https://sqlite.org/c3ref/busy_timeout.html): espera limitada por conexão.
- [S8 — SQLite Backup API](https://sqlite.org/backup.html): backup online consistente.
- [S9 — VACUUM](https://sqlite.org/lang_vacuum.html#vacuuminto): snapshot e limites do destino interrompido.
- [S10 — ALTER TABLE](https://sqlite.org/lang_altertable.html#otheralter): migração transacional/reconstrução.
- [S11 — Copyright](https://sqlite.org/copyright.html): domínio público e exceção dos scripts.
- [S12 — Release History](https://sqlite.org/changes.html): release/source ID, não biblioteca do host.
- [S13 — How To Corrupt An SQLite Database](https://sqlite.org/howtocorrupt.html): locks/FS, cópias inseguras, rename/unlink em uso.
- [S14 — Self Contained System](https://sqlite.org/selfcontained.html): dependências C/OS/VFS.
- Depriorizados: resumos de busca, mirrors históricos `system.data.sqlite.org` e análise secundária do WAL-reset; fontes atuais oficiais bastam, sem benchmark/performance comparativa.

[P]: ../../../tecnologia/software-factory-0.0.1-prd.md
[T]: ../issues/02-durability-strategy.md
[M]: ../durability-comparison.md
