# 13: Sessão substituta: pacote e conduta

**What to build:** A perda encerra a Execução. A sessão substituta entra pela fila como nova Execução, consome uma retomada operacional do orçamento
existente e recebe instrução explícita de recuperação. Na prova, a substituta não presumiu o que sumiu, mas não concluiu a fase; aqui a
conduta é imposta: concluir, publicar e perguntar sobre o efeito incerto. A reconciliação é uma Pergunta comum do MVP, sem mecanismo
novo.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-10, V2-18, V2-19 (gate obrigatório: a prova reprovou a ausência disto, P2).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 12

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Depois de uma perda, o Trabalho volta à fila; a nova Execução consome uma retomada operacional. Sem retomada disponível, vale a regra de orçamento do MVP.
- [ ] O pacote da substituta traz: Trabalho, Execução, boots com motivo, último commit confirmado, a perda declarada, os efeitos de resultado incerto registrados pelo Controle, o consumo acumulado e a ref de marcador de perda, se existir, para aproveitar em vez de refazer. Sem transcript nem resumo da sessão anterior.
- [ ] A substituta nunca repete um efeito de resultado incerto.
- [ ] A substituta conclui o que não depende do efeito incerto.
- [ ] Se o restante depende dele, abre uma Pergunta descrevendo o efeito e o registro do Controle; a resposta autoriza repetir ou dar por feito.
- [ ] O gate de preservação precede o fim de toda ativação da substituta: ela publica o que fez antes de devolver o controle.
- [ ] Cenário integrado sobre o fake: perda com efeito incerto registrado; a substituta conclui, publica e pergunta (os três pontos do gate obrigatório), e a resposta à Pergunta leva o Trabalho adiante.
