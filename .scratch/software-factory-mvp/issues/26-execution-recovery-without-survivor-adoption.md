# 26: Recuperar Execuções sem adotar sobreviventes

**What to build:** Após crash ou parada, a Factory descobre o que realmente iniciou, cessa sobreviventes próprios e retoma somente com autoridade/capacidade comprovadas. Contexto e limites persistem sem adotar processo antigo nem repetir ferramenta cegamente.

**Blocked by:** [11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas](11-context-continuation-and-authorized-scope.md); [19: Aplicar limites, timeout opcional e concessões explícitas](19-budgets-optional-timeout-and-grants.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Boot exclusivo valida compatibilidade e abre Pi Durable com barreira fechada; inventaria reservas, recibos, recursos e processos próprios, inclusive cache em preparo e adapter anterior morto.
- [ ] Sobreviventes são encerrados, não adotados; observação host comprova cessação de workers/VMM/subprocessos capazes de atuar antes de substituto, sem usar PID isolado, abort ou token como prova.
- [ ] Recibo completo sincronizado confirma início e consumo único mesmo sem notificação; ausência só prova não início com storage íntegro/barreira e ausência ou cessação de atividade, senão mantém reserva.
- [ ] Reconciliação atual incorpora evidências antigas explicitamente; mensagem de abertura/Execução/boot antigo não altera reserva vigente e replay de task não autoriza spawn.
- [ ] Incerteza local bloqueia Trabalho/capacidade afetados sem impedir independentes seguros; incerteza global de autoridade/capacidade mantém despacho fechado, sem ignorar recursos desconhecidos.
- [ ] Falhas operacionais recuperáveis voltam à fila sob contagem separada e espera persistida de 5/15/45 segundos ou maior indicada pelo serviço; eventos repetidos não antecipam prazo nem renovam orçamento.
- [ ] Parada administrativa só é limpa após cessação e persistência comprovadas, permitindo continuação sem recovery só pela parada; crash/forçada/incerta preserva tratamento de falha e evidência temporal.
- [ ] Provas reais com cortes em reserva/spawn/recibo/ferramenta/cache/processos demonstram ausência de escritor/consumo duplicado e preservação de contexto; perda de saída exige inspeção, não replay arbitrário.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.4, 4.4, 5.2, 5.3, 5.4, 5.7, 11.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-01, V-07, V-12, V-13 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
