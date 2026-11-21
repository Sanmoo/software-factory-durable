# 09: Troca planejada de boot e limite contra laço

**What to build:** Uma Execução mais longa que a duração máxima do boot continua em outro boot sem perder identidade. Ao cruzar a margem, o Controle não
interrompe a chamada em curso; quando ela retorna, entrega o aviso de troca como ativação própria: o Builder publica o WIP, o gate aceita,
a cessação é confirmada e só então outro boot é iniciado. A troca mantém Trabalho, Execução, Slot, relógio de timeout e sessão; muda só
a referência de boot. Dois boots seguidos sem commit novo publicado geram Bloqueio em vez de um terceiro boot.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-10, V2-12, V2-13, V2-14.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 08

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Duração máxima (padrão 3600 s) e margem (padrão 600 s) vêm do perfil do adapter, lidas pelo Controle como capacidade; a duração do boot é limite distinto do timeout da Execução.
- [ ] Ao cruzar a margem com chamada em curso, o Controle espera o retorno e então entrega o aviso de troca como ativação própria.
- [ ] Sequência imposta: WIP publicado, gate aceito, cessação confirmada, novo boot iniciado; nunca dois boots do mesmo Trabalho ao mesmo tempo.
- [ ] Se a chamada não retornar até restar metade da margem, o adapter a interrompe e pede o WIP com o tempo que sobra.
- [ ] Se o gate não aceitar antes do fim do boot, vale o caminho de perda (registrado como tal; o tratamento completo é dos tickets 12 e 13).
- [ ] A troca planejada mantém Trabalho, Execução, Slot, relógio de timeout e sessão, não consome retomada operacional e registra o boot com motivo "troca planejada".
- [ ] Dois boots seguidos do mesmo Trabalho encerrados sem nenhum commit novo publicado entre eles geram Bloqueio com o diagnóstico "sem progresso entre boots", em vez de um terceiro boot.
- [ ] Testes com relógio falso, sem `sleep`; a troca sob margem real e o boot acima de uma hora ficam para o aceite (ticket 16).
