# 13: Tratar achados e comprovar gates sobre o conteúdo atual

**What to build:** O operador consegue verificar como cada achado foi tratado e quais validações realmente cobrem a proposta atual. O Builder itera com os revisores quando muda conteúdo, sem fabricar aprovação ou apresentar comando não executado como verde.

**Blocked by:** [10: Perguntar ao operador, cessar e retomar pela fila](10-durable-questions-and-queued-resumption.md); [12: Obter Standards e Spec paralelos sobre a proposta completa](12-parallel-standards-and-spec-reviews.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Cada achado registra corrigido ou não acolhido com justificativa/evidência; discordância interna não exige arbitragem por si, mas dúvida de requisito, dispensa ou aprovação exigida pela skill passa por ask user quando não há autorização concreta prévia.
- [ ] Builder identifica gates documentados com fonte, comando/cwd e resultado real/status/log correlacionados a conteúdo e Execução; sucesso, falha, ausência e dispensa autorizada são distintos.
- [ ] Resultado da ferramenta protegida sustenta evidência, não stdout declarado ou cópia editável; falha não resolvida, instrução faltante ou impossibilidade exige orientação explícita.
- [ ] Proposta/contexto relevante modificado exige parecer atual e justificado dos dois revisores; novas rodadas preferem sessões compatíveis e não reutilizam aprovação antiga automaticamente.
- [ ] Justificativa fora da proposta sem mudar contexto e commit comprovadamente idêntico ao conteúdo revisado não exigem rodada por si; correspondência e vínculo ao commit são demonstrados.
- [ ] Controle verifica presença/correlação dos pareceres, tratamentos, gates e dispensas, sem certificar semanticamente todos os documentos nem deixar dispensa humana contornar check GitHub obrigatório.
- [ ] Testes com agentes reais cobrem achado corrigido, não acolhimento, rodada após mudança, commit idêntico e falha/resultado perdido, sempre sem interpretar ausência de evidência como sucesso.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.6, 6.3, 6.4, 9.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-08, V-09, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
