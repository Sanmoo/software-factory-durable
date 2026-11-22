# 02: Atualizar o armazenamento sem interromper um Trabalho GitHub

**What to build:** Com o controlador parado, o operador consegue validar e aplicar a atualização sem perder a fila ou interromper a conversa de um Trabalho existente.

**Blocked by:** [01 — Separar a origem do Ticket do destino do Trabalho](01-separar-origem-e-destino.md)

Status: ready-for-agent

- [ ] Inspecionar dados e configuração antes da primeira escrita incompatível. Distinguir versão do YAML de formato persistido; formato 1 exige o caminho explícito até 2. Recusar formato misto, desconhecido ou inspeção inconclusiva sem escrita.
- [ ] O manifesto declara a transformação factory-storage-2-to-3. Um único commit preserva chaves e IDs GitHub, índices, ciclos inclusive após forget, FIFO, cursores, recibos, perguntas, PRs e efeitos pendentes. Comparar contagens, referências e digest; interrupção deixa a versão antiga ou nova íntegra.
- [ ] Em armazenamento real temporário no formato 2, migrar uma pergunta GitHub já publicada, reabrir e entregar a mesma resposta duas vezes: uma transição no mesmo Trabalho, sem republicação, novo Trabalho ou chamada Jira.
- [ ] Rollback pré-checa dados **e** configuração contra a release anterior. Se um deles for incompatível, manter a seleção atual e orientar correção para a frente, sem prometer migração reversa ou replay externo.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §6; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
