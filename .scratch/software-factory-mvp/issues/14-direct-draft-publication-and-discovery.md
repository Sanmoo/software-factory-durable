# 14: Publicar e reconhecer o PR draft próprio

**What to build:** Depois da implementação/revisão, o Builder publica sua branch e abre o PR draft com descrição curta. A Factory reconhece a publicação própria e recupera resultado incerto antes de repetir push ou criação.

**Blocked by:** [13: Tratar achados e comprovar gates sobre o conteúdo atual](13-findings-treatment-and-current-content-gates.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Builder usa pr para redigir e publica diretamente por Git/API usando App restrita ao repo; controlador não faz push por gateway e não presume que carregar a skill publicou.
- [ ] Associação Trabalho/Ticket/repo/branch/base/PR é inequívoca e preserva identidades; PR abre draft após reviews aplicáveis, sem encerrar Ticket pela simples abertura.
- [ ] Descrição resume mudança/razão/vínculo, validação/limitações/dispensas e risco humano; detalhes protegidos ficam separados, sem transcrição integral nem caminho local apresentado como link remoto útil.
- [ ] Ausência de PR conhecido leva a solicitação de publicação ao Builder; branch com nome esperado não prova autoria e PR desconhecido não é adotado.
- [ ] Registros normais preservam refs e evidências recuperáveis usadas, sem exigir intenção/ACK extra, wrapper Git/gh ou parser de shell por push/criação.
- [ ] Após cessação e resultado perdido, observação Git local/remoto/PR encontra publicação correlacionada antes de repetir; múltiplos candidatos, leitura incompleta ou mudança desconhecida bloqueiam repetição insegura.
- [ ] Integração com agente e GitHub reais demonstra draft próprio, identidade, descrição e descoberta de publicação incerta, sem merge/aprovação humana pelo agente.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 2.1, 8, 9.1; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-09, V-12 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
