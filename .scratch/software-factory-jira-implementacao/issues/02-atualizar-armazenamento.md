# 02: Atualizar o armazenamento sem interromper um Trabalho GitHub

**What to build:** Com o controlador parado, o operador consegue validar e aplicar a atualização sem perder a fila ou interromper a conversa de um Trabalho existente.

**Blocked by:** [01 — Separar a origem do Ticket do destino do Trabalho](01-separar-origem-e-destino.md)

Status: resolved

- [x] Inspecionar dados e configuração antes da primeira escrita incompatível. Distinguir versão do YAML de formato persistido; formato 1 exige o caminho explícito até 2. Recusar formato misto, desconhecido ou inspeção inconclusiva sem escrita.
- [x] O manifesto declara a transformação factory-storage-2-to-3. Um único commit preserva chaves e IDs GitHub, índices, ciclos inclusive após forget, FIFO, cursores, recibos, perguntas, PRs e efeitos pendentes. Comparar contagens, referências e digest; interrupção deixa a versão antiga ou nova íntegra.
- [x] Em armazenamento real temporário no formato 2, migrar uma pergunta GitHub já publicada, reabrir e entregar a mesma resposta duas vezes: uma transição no mesmo Trabalho, sem republicação, novo Trabalho ou chamada Jira.
- [x] Rollback pré-checa dados **e** configuração contra a release anterior. Se um deles for incompatível, manter a seleção atual e orientar correção para a frente, sem prometer migração reversa ou replay externo.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §6; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

- Formato 3 = formato 2 com `factory.installation` v3 (`storage.format: 3`); demais documentos intocados. Uma release de formato 2 recusa
  o armazenamento 3. A matriz (formato, `migratesFrom`, ids das transformações e versão de cada tipo de documento) fica em
  `controlStorageCompatibility` e vai para `metadata.storage` do manifesto; `formats.configuration` passa a ser a lista `[1, 2]`.
- `factory-storage-2-to-3` explícita, em um commit, com digest verificado antes e contagens/digest/referências comparados depois; formato 1
  passa pelo `factory-storage-1-to-2` existente e depois 2→3 no mesmo commit (`--migrate factory-storage-1-to-2,factory-storage-2-to-3`,
  um registro por etapa). Tipo de documento fora do formato detectado = `STORAGE_FORMAT_MIXED`; desconhecido, versão nova ou digest
  divergente recusados sem escrita. Abertura operacional continua recusando `migration-required`.
- Armazenamento real formato 2 com pergunta GitHub publicada e memória de Trabalho esquecido: migra, reabre duas vezes, a mesma resposta
  chega por comentário (várias leituras e reinício) e pelo mesmo `request_id` local: uma transição, sem novo Trabalho, sem POST, sem chamada Jira.
- Rollback pré-checa dados **e** configuração (versão real do `config.yaml` contra o que a release anterior declara), reporta os dois
  (`rollback:storage`, `rollback:configuration`), mantém a seleção e orienta correção para a frente, sem prometer migração reversa ou restauração.
