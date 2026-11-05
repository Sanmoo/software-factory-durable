# Investigar DBOS como controle durável local da fábrica

Status: resolved
Claimed by: pesquisador delegado pelo responsável do mapa
Claim context: rodada de durabilidade autorizada pelo operador; sessão supervisora Pi `01a1a0f3-937b-72a8-8dc8-48e21281587a`.
Research branch: research/software-factory-dbos-control
Research worktree (histórica; removida limpa após publicação/verificação): /home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/sf-research-dbos-control
Research report: .scratch/software-factory/research/dbos-control.md
Research workflow: e7e44352-d35b-4c31-bcc2-bdac2708af23
Publication owner: supervisor; pesquisadores têm read/write/web sem shell/git. Após entrega, supervisor valida, commita e publica somente a branch de pesquisa correspondente via SSH BatchMode; sem merge/PR.
Research state: pesquisa documental verificada e publicada pelo supervisor; worktree removida limpa, branches de evidência preservadas, sem escolha tecnológica.
Local report: [Relatório preservado](../research/dbos-control.md)
Type: research
Label: wayfinder:research
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: none

## Question

Qual é a composição mínima self-hosted de DBOS que pode controlar o Trabalho da fábrica, além da execução de agentes, e quais garantias/obrigações ela fornece nos cortes do PRD?

Investigar SDK TypeScript e distinguir explicitamente Python quando alterar dependências ou garantias; não há linguagem aprovada. Fixar versões/SHAs e licença do SDK, identificar componentes opcionais/comerciais e não assumir Conductor obrigatório. Cobrir sistema de checkpoints, transações e entrega, exclusividade/recuperação de workflow, filas e prioridades/FIFO, espera humana sem Slot ocupado, retry e cancelamento. Distinguir concorrência interna de builders/processos e efeito externo concluído antes do checkpoint.

Explicar um encaixe conceitual para o estado persistente de admissão/fila/Slot/pergunta/intenções: quais invariantes podem compartilhar a autoridade transacional e quais exigem estado/protocolo adicional. Não implementar schema ou código. Avaliar atualização com parada controlada e perguntas pendentes: compatibilidade de código, versão de workflows, preservação/substituição de contexto e custo de manter código antigo, sem exigir rolling update. Apontar APIs exatas, limites e fatos não confirmados; ausência de documentação não prova impossibilidade.

Não instalar serviços/SDKs, executar modelos ou provas, usar credenciais reais ou alterar host. Fontes primárias documentais; relatório de aproximadamente 1500–2500 palavras, sem vencedor ou pontuação. Incluir o mínimo que cada dependência elimina de código próprio e o que permanece próprio, sem estimar LOC/tempo sem evidência.

## References

- [PRD — Software Factory MVP](../prd.md): RF-01, RF-03–04, RF-10, RF-12–13, RNF-01 e CA-03/05/06/07.
- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md): pergunta decisória e atualização controlada aprovada.
- [Matriz de evidências e lacunas de durabilidade](../durability-comparison.md): artefato de comparação, não escolha.
- [DBOS — guia TypeScript](https://docs.dbos.dev/typescript/programming-guide): pista inicial de checkpoints e PostgreSQL; consulta preliminar não é avaliação completa.

## Comments

- Pesquisa nova: DBOS não foi coberto pela investigação inicial de runtimes. O responsável do mapa registra resolução; pesquisador edita somente o relatório em sua branch.

## Answer

Pesquisa documental concluída e verificada. [Relatório imutável](https://github.com/Sanmoo/pkm/blob/b61cd35a7e95dac95c543ab510c255524e30c54d/.scratch/software-factory/research/dbos-control.md), commit `b61cd35a7e95dac95c543ab510c255524e30c54d`, branch `research/software-factory-dbos-control`; consulta 2026-11-03.

- DBOS pode controlar mais que sessões: workflows/passos, transações de datasource com checkpoint atômico, mensagens e filas. TS exige PostgreSQL; Python permite SQLite. Core MIT, Conductor/Enterprise opcionais com fronteira comercial própria.
- O estado de domínio pode compartilhar a base SQL, mas startWorkflow não é uma transação ambiente de reserva+despacho. Datasource/funções SQL ou intenção idempotente são composições a escolher; não se demonstrou dequeue interno e reserva do produto num único commit pronto.
- Prioridade/FIFO e concorrência das filas não implementam sozinhos ordem original na retomada, seleção elegível e Slot livre durante espera. Ownership impede checkpoints obsoletos, não escrita do builder sobrevivente em Git/worktree.
- Suspensão TS com recv/sleep suspend:true é Enterprise no snapshot examinado, não afirmação sobre toda espera core ou sobre a release publicada. Releases TS v5.4/Python 3.4.0 e snapshots posteriores estão separados no relatório; não adotar API de main silenciosamente.
- Atualização controlada não elimina compatibilidade de replay/código/estado. Perguntas, limites, intenções e contexto precisam preservação/migração explícita. Cancelamento/retry internos não substituem supervisão e contadores do PRD.

**Verificação do supervisor:** relatório integralmente lido (1900 palavras); fontes primárias DBOS de transação/checkpoint e ownership/zumbis confrontadas por amostragem; links locais e escopo de único arquivo conferidos; git diff --check incluindo staged novo arquivo passou. O supervisor executou commit e push exclusivo da branch via SSH BatchMode e confirmou SHA remoto idêntico por ls-remote. Sem merge/PR; worktree removida limpa, branches local/remota preservadas como evidência.

**Limites:** avaliação documental, sem execução de SDK/modelo/serviço/provas. A resolução informa a comparação; não escolhe DBOS, linguagem ou runtime nem comprova CA-01–12. Provas futuras de processos, GitHub, fila e upgrade permanecem necessárias sob autorização própria.
