# 02: Operar um controlador exclusivo com pausa durável

**What to build:** O operador inicia um único controlador e consulta ou altera a pausa pela CLI, com resultado durável e consultável mesmo quando a conexão cai. Reinício preserva a pausa, e nenhuma atuação é liberada antes da reconciliação.

**Blocked by:** [01: Preparar a instalação local e o gate de desenvolvimento](01-local-setup-and-development-gate.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Lock estável do storage canônico é adquirido antes de abrir Pi Durable/SQLite ou aceitar mutações; segunda abertura e aliases não criam outro proprietário, e subprocessos não herdam o descritor.
- [ ] SQLite efetivamente embarcado tem correção WAL-reset verificada e opera WAL/synchronous=FULL nos commits de controle pela fronteira pública suportada; falha de persistência não produz ACK durável.
- [ ] Status, pause, unpause e request passam por socket privado, sem leitor operacional paralelo; controlador indisponível é erro explícito, não lista vazia.
- [ ] Identidade do pedido e transição/histórico são confirmados no mesmo commit; mesmo ID/conteúdo retorna resultado conhecido, conteúdo diferente falha e perda de ACK permite consultar ou repetir a mesma identidade.
- [ ] Framing JSON por linha valida versão/limites, fragmentação e campos; transporte não confunde recibo de bytes com confirmação durável.
- [ ] Barreira começa fechada inclusive em resume/submit/waits e caminhos fora do loop principal; pausa persiste sem cancelar Trabalhos ou autorizar despacho implicitamente.
- [ ] Testes com storage e sockets temporários reais cobrem reinício, falhas de commit, exclusividade e ingresso duplicado; regras usam dados/tempo controlados, sem domínio ou scheduler paralelo.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.1, 3.4, 5.1, 5.2, 11.3, 13.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-01, V-11 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
