# 09: Iniciar Builder com checkout próprio e pedido preservado

**What to build:** Um Ticket autorizado e sem impedimentos chega a um Builder real em branch/checkout/ambiente próprios. O Builder preserva o pedido e as instruções antes de implementar uma mudança verificável, com identidade e Slot duráveis.

**Blocked by:** [05: Executar um worker SDK com ferramentas confinadas e saída protegida](05-confined-sdk-worker-and-protected-output.md); [06: Executar testes Docker reais no perfil distribuível](06-real-docker-tests-on-supported-profile.md); [08: Liberar execução somente com dependências nativas satisfeitas](08-native-dependency-gating.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Controle revalida elegibilidade/dependências/capacidade e confirma Execução vigente, Slot e intenção/tarefa de despacho antes de preparar/ativar; recibo de início incorpora consumo uma única vez.
- [ ] Cache bare exclusivo da Factory sequencia fetch e clone local concluído por repo, sem mutex global de execução; cópia independente usa no-hardlinks, sem alternates/shared/reference e remoto GitHub.
- [ ] Preparo host não executa hooks/scripts/plugins do repo nem monta cache no guest; branch/workspace/metadados próprios são reutilizados nas continuações, sem escrita comum entre Trabalhos.
- [ ] Builder recebe Ticket/repo/base inequívocos, pacote próprio versionado de implement/code-review/pr/tdd/dependências e diagnóstico Alpine com origem/créditos/licenças, sem perfil pessoal.
- [ ] Credencial inicial restrita ao repo é entregue transitoriamente pelo caminho host antes das ferramentas dependentes; chave/token não entram em estado serializável, prompt, sessão, recibo ou remoto Git.
- [ ] Builder começa por implement e preserva fontes necessárias/instruções aplicáveis fora da proposta, com manifesto final completo, origem/data/hash/revisão e versões não sobrescritas; controlador não ingere documentos.
- [ ] Fonte necessária inacessível ou aprovação não disponível impede conclusão automática e é explicitada, sem ampliar token nem adotar fonte auxiliar como requisito silencioso.
- [ ] Prova com agente real relaciona autorização, reserva, recibo, perfil/spec, comandos e alteração observada; não habilita retry automático ou publicação antes dos contratos correspondentes.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.4, 5.3, 6.1, 6.2, 6.3, 7.3, 8.1; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-04, V-07, V-08 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
