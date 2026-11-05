# 33: Atualizar com compatibilidade verificada e migração recuperável

**What to build:** O operador troca de release por procedimento explícito que preserva Trabalho e Pergunta pendentes, recusa incompatibilidade antes de alterar estado e permite concluir ou recuperar migração suportada interrompida.

**Blocked by:** [11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas](11-context-continuation-and-authorized-scope.md); [26: Recuperar Execuções sem adotar sobreviventes](26-execution-recovery-without-survivor-adoption.md); [32: Distribuir uma release autocontida e verificável](32-self-contained-verifiable-release.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Atualização orienta pausar e parar com cessação/persistência confirmadas, extrair/verificar nova release separada e preservar anterior; intenção de parada não torna crash em parada limpa.
- [ ] Antes de modificar estado verifica config/backend/schema, documentos/tasks/registry, protocolo, perfil/skills, sessões e ambientes/assets; incompatível bloqueia sem apagar/ressubmeter tasks para contornar.
- [ ] Somente migração suportada e explicitamente solicitada é executada, preservando IDs/índices/ciclos/FIFO/Perguntas/respostas/reservas/limites/efeitos e referências necessárias.
- [ ] Interrupção durante migração é detectável com caminho próprio de conclusão/recuperação; estado parcial não é aceito como operacional sem saída conhecida.
- [ ] Nova release inicia pausada, reinstala registry compatível e reconcilia/permite inspeção antes de despausar; pergunta pendente continua respondível e retomada conserva contexto compatível ou substituição registrada.
- [ ] Discos/base/perfil não são migrados nem assets dependentes removidos implicitamente; release antiga só opera formato compatível, sem promessa de rolling update ou rollback universal.
- [ ] Provas reais cobrem troca com Pergunta pendente, incompatibilidade recusada e migração suportada interrompida, usando fronteiras públicas sem edição operacional de storage.
- [ ] Procedimento não adiciona backup/restauração integrado, agendamento ou certificação de cópias; proteção contra perda de storage permanece externa e não desfaz GitHub.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.2, 6.1, 11.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-01, V-07, V-12, V-16 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
