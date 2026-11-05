# 16: Converter prontidão somente com evidências atuais

**What to build:** O controlador só declara e converte o PR para revisão humana quando todas as evidências atuais de preparação estão satisfeitas. O operador distingue prontidão interna, flag draft/ready, revisão humana e entrega.

**Blocked by:** [15: Explicar os checks obrigatórios do PR atual](15-required-checks-evaluation.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Avaliação combina ownership/estado, conteúdo/spec/instruções, dois pareceres atuais, tratamentos, gates/dispensas, checks, ausência confirmada de conflito e todos os impedimentos pertinentes.
- [ ] Antes de converter, reconsulta identidade/head/base/requisitos; alteração invalida avaliação externa e exige recalcular, sem reviews/rebase só porque a base avançou.
- [ ] Intenção do efeito é confirmada antes da mutação remota, seguida de observação e confirmação durável; conversão incerta exige descoberta antes de repetir.
- [ ] Perda confirmada de condição retira prontidão e converte draft com motivo; consulta transitória/incerta retira confirmação interna sem oscilar a flag por falha de rede.
- [ ] Draft colocado pela Factory pode ser restaurado após avaliação completa; draft humano inesperado exige autorização antes de reconverter, e flag ready isolada não certifica prontidão.
- [ ] Review humano pendente não impede por si receber revisão humana e tampouco autoriza o agente a aprovar ou realizar merge.
- [ ] Provas reais de conversão e testes de corrida/correlação demonstram ausência de verde emprestado, reconsulta prévia e razões independentes de impedimento.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.3, 9.2, 9.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-09, V-12 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
