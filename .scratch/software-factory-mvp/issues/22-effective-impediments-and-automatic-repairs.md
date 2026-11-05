# 22: Executar reparos automáticos por impedimentos efetivos

**What to build:** A Factory acompanha o mesmo PR e inicia correção prioritária somente quando existe impedimento efetivo e autorizado. Eventos repetidos consolidam contexto sem criar escritores paralelos, cobranças por evento ou reparos por simples avanço da base.

**Blocked by:** [11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas](11-context-continuation-and-authorized-scope.md); [15: Explicar os checks obrigatórios do PR atual](15-required-checks-evaluation.md); [19: Aplicar limites, timeout opcional e concessões explícitas](19-budgets-optional-timeout-and-grants.md); [21: Preservar mudanças humanas durante atualização da branch](21-human-changes-and-explicit-lease.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Gatilhos automáticos são conflito confirmado, check obrigatório atual pertinente falho e strict que efetivamente exige atualização; CI/review pendentes, mergeability desconhecida, opcional/antigo ou base apenas avançando não bastam.
- [ ] Trabalho/correção/Execução existentes guardam motivos, contexto, posição e cobrança, sem fila adicional, máquina de estados por evento ou ACK de consumo por feedback.
- [ ] Nova correção recebe sequência de reparo, continuações/eventos consolidados mantêm identidade/FIFO; seleção prioriza reparos sem preempção e preserva orçamento reservado/consumido.
- [ ] Antes do início reconsulta requisitos, motivos, ownership, dependências e limites; se todos os motivos desapareceram, retira pendência sem cobrar, salvo reserva/início incerto que exige reconciliação.
- [ ] Builder recebe motivos relevantes por continue ou recuperação, valida, obtém reviews aplicáveis e publica com lease seguro quando necessário; feedback novo aguarda ativação segura sem outro escritor.
- [ ] Correção encerra após tratamentos, reviews/gates, publicação reconciliada e cessação, sem esperar CI; nova falha pertinente pode criar outra, mas evento antigo/problema declarado insolúvel bloqueia/pergunta em vez de gastar novamente.
- [ ] Testes de regras/fluxos e integrações reais demonstram um reparo consolidado e cobrado uma vez, ausência de disparo por não gatilhos e manutenção do mesmo PR.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 4.3, 4.4, 9.2, 10; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-06, V-09, V-10 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
