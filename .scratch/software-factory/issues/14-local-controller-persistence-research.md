# Verificar a base transacional de um controlador próprio local

Status: resolved
Claimed by: pesquisador delegado pelo responsável do mapa
Claim context: rodada de durabilidade autorizada pelo operador; sessão supervisora Pi `01a1a0f3-937b-72a8-8dc8-48e21281587a`.
Research branch: research/software-factory-local-controller
Research worktree (histórica; removida limpa após publicação/verificação): /home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/sf-research-local-controller
Research report: .scratch/software-factory/research/local-controller-persistence.md
Research workflow: e7e44352-d35b-4c31-bcc2-bdac2708af23
Publication owner: supervisor; pesquisadores têm read/write/web sem shell/git. Após entrega, supervisor valida, commita e publica somente a branch de pesquisa correspondente via SSH BatchMode; sem merge/PR.
Research state: pesquisa documental verificada e publicada pelo supervisor; worktree removida limpa, branches de evidência preservadas, sem escolha tecnológica.
Local report: [Relatório preservado](../research/local-controller-persistence.md)
Type: research
Label: wayfinder:research
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: none

## Question

Quais mecanismos e limites documentados de SQLite permitem uma base mínima de controlador local próprio para o PRD, e quais responsabilidades de recuperação não são fornecidas pelo banco?

Definir a alternativa própria concretamente, sem implementar: armazenamento transacional de identidade/admissão/fila/Slot/pergunta/intenções/contadores; serialização de mutações e reserva antes de spawn; aplicação do resultado e retomada após consulta dos pendentes. Separar propriedades documentadas do SQLite de inferências de desenho da fábrica. Não propor um motor genérico, DSL, event sourcing obrigatório, broker ou plugins.

Consultar fontes oficiais SQLite para ACID, isolamento e concorrência entre conexões/processos, transações de escrita/BUSY, WAL e synchronous, distinção entre crash de processo e host/energia, backup consistente e migração transacional de schema. Explicar por que lock do banco não garante exclusividade de escritor Git e por que commit local não atomiza GitHub, filesystem ou spawn. Informar cuidados de persistência/FS e limitações; não introduzir SLA/RPO/HA novos nem decidir a política pelo humano.

Usar os mesmos cortes CA-06 e atualização controlada do ticket decisório para inventariar código próprio obrigatório, fronteira mínima de transação/reconciliação e lacunas empíricas. Identificar licença e dependências de SQLite; binding da linguagem ainda não está escolhido. Aproximadamente 1200–2000 palavras com citações. Nenhuma medição/estimativa de LOC ou alegação de menor complexidade sem evidência.

Pesquisa documental AFK: não instalar/executar banco, SDK, modelos, serviços ou provas, não usar credenciais reais nem alterar host. Código descritivo/schema executável não é necessário; texto e tabelas bastam.

## References

- [PRD — Software Factory MVP](../prd.md): RF-01, RF-03–04, RF-10, RF-12–13 e RNF-01.
- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md): nenhuma escolha aprovada.
- [Matriz de evidências e lacunas de durabilidade](../durability-comparison.md).
- [SQLite — documentação oficial](https://sqlite.org/docs.html).

## Comments

- A alternativa própria ainda não tinha evidência primária nem composição suficientemente concreta. Esta pesquisa estabelece uma base comparável, não favorece SQLite por ter menos serviços.

## Answer

Pesquisa documental concluída e verificada. [Relatório imutável](https://github.com/Sanmoo/pkm/blob/1d60fd540f4d68a66a47f340c4b4f5b32f29e8b8/.scratch/software-factory/research/local-controller-persistence.md), commit `1d60fd540f4d68a66a47f340c4b4f5b32f29e8b8`, branch `research/software-factory-local-controller`; consulta 2026-11-03.

- SQLite permite transações locais conjuntas de identidade/admissão/fila/reserva/pergunta/intenções, com escritas serializadas; regras de negócio, dispatcher, retries/limites, inspeção e reconciliação são código da fábrica. Nenhum motor genérico/DSL/event sourcing é necessário para essa hipótese.
- WAL/NORMAL preserva commits contra crash da aplicação, mas pode perdê-los após crash do host/energia; WAL/FULL acrescenta sincronização por commit sob as premissas de OS/FS/hardware. Isso explicita configurações, sem impor novo SLA/RPO/HA ou escolher binding.
- Lock do banco não cerca builder externo. Commit local não atomiza spawn/Git/GitHub: persistir intenção, descobrir processo/efeito e confirmar antes de substituir/repetir. O inventário por corte CA-06 permanece compatível com publicação direta pelo builder.
- Backup consistente e migração transacional de schema são documentados; backup não inclui automaticamente artefatos, nem migração de schema equivale a migrar semântica/contexto. Restauração requer redescobrir efeitos remotos. Perguntas pendentes podem atravessar atualização controlada com compatibilidade explícita.
- SQLite é autocontido/domínio público; binding, versão efetivamente embarcada, defaults e dependências permanecem a fixar. O aviso oficial WAL-reset exige versão corrigida (3.51.3+ ou backports indicados), inclusive quando SQLite é dependência interna de outra plataforma.

**Verificação do supervisor:** relatório integralmente lido (1985 palavras); diferenças FULL/NORMAL e aviso WAL-reset confrontados nas fontes oficiais; fontes/links locais e escopo de único arquivo conferidos; git diff --check incluindo staged novo arquivo passou. Supervisor executou commit, publicação exclusiva via SSH BatchMode e ls-remote confirmando o SHA remoto.

**Preservação e limites:** worktree removida limpa; branches local/remota preservadas, sem merge/PR. Não houve execução de SQLite/modelos/serviços/provas. Esta resolução fundamenta a alternativa própria, não prova CA-06 nem a torna mais simples que bibliotecas/motores. Testes de crash, sobreviventes, BUSY/I/O/disco, backup/restore e migração exigem autorização posterior.
