# 05: Explicar no Card por que o Trabalho não começou

**What to build:** Quem marcou o Card recebe o motivo do impedimento e uma ação corretiva quando a fábrica pode confirmar intenção e audiência. O aviso não exige criar um Trabalho.

**Blocked by:** [02 — Atualizar o armazenamento sem interromper um Trabalho GitHub](02-atualizar-armazenamento.md); [03 — Explicar se um candidato Jira pode iniciar](03-avaliar-candidato.md)

Status: resolved

- [x] Indexar impedimentos por Ticket e motivo. Reavaliar com fatos novos; o mesmo motivo não repete aviso, um motivo novo pode gerar outro. Com etiqueta retirada, intenção ou audiência incerta, não postar. Nunca divulgar dados restritos do vizinho.
- [x] Persistir destino, referência lógica e conteúdo antes do POST de comentário Platform em ADF. Se a resposta se perder, após reinício paginar os comentários visíveis e comparar conta autora, referência e conteúdo.
- [x] Uma correspondência confirma; zero em leitura completa permite reenviar com a mesma referência. Duas, acesso negado ou página faltante deixam pendência e diagnóstico sem POST cego. Demonstrar o efeito lógico sem prometer cópia visual única.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §4; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

Impedimentos pré-admissão ficam num documento do formato 3 (`factory.jira-impediment`, por chave do Ticket, sem Trabalho fictício). A regra pura `impedimentNotice` (`src/control/rules/jira-notices.ts`) só avisa um Card `blocked` com etiqueta recém-relida e audiência do próprio Card; o motivo é identificado por códigos comunicáveis (e repositórios divergentes), nunca pelo vizinho; o mesmo motivo não repete, um motivo novo gera outro aviso; etiqueta retirada, elegível, não verificável ou audiência incerta ficam em diagnóstico local (`status.jiraNotices`).
Comentários automáticos Jira são efeitos recuperáveis genéricos (`factory.jira-comment`, `src/control/durable/jira-comments.ts`, reutilizáveis por 06/09): destino, referência lógica (`[Software Factory · Impedimento I-xxxxxxxx]`) e conteúdo gravados antes do POST Platform em ADF sem `visibility`; após resposta perdida ou crash, todas as páginas de comentários visíveis são comparadas por conta (`GET /myself` sob demanda), cabeçalho e conteúdo: uma correspondência confirma, zero em leitura completa reenvia com a mesma referência (limitado), duas, cópia editada, 403 ou página faltante deixam pendência com diagnóstico, sem POST. A regra GitHub não mudou. Ponto de entrada para o poller (04/10): `noticeJiraImpediments` (exportado de `src/control/index.ts`); descoberta Jira segue desligada.

Commits: `bffdc915`. Gate: `npm run test:ci` PASS (2210 testes, 0 falhas).
