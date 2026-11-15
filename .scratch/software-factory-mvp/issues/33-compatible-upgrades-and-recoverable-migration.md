# 33: Atualizar com compatibilidade verificada e migração recuperável

**What to build:** O operador troca de release por procedimento explícito que preserva Trabalho e Pergunta pendentes, recusa incompatibilidade antes de alterar estado e permite concluir ou recuperar migração suportada interrompida.

**Blocked by:** [11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas](11-context-continuation-and-authorized-scope.md); [26: Recuperar Execuções sem adotar sobreviventes](26-execution-recovery-without-survivor-adoption.md); [32: Distribuir uma release autocontida e verificável](32-self-contained-verifiable-release.md)

**Status:** resolved

## Acceptance criteria

- [x] Atualização orienta pausar e parar com cessação/persistência confirmadas, extrair/verificar nova release separada e preservar anterior; intenção de parada não torna crash em parada limpa.
- [x] Antes de modificar estado verifica config/backend/schema, documentos/tasks/registry, protocolo, perfil/skills, sessões e ambientes/assets; incompatível bloqueia sem apagar/ressubmeter tasks para contornar.
- [x] Somente migração suportada e explicitamente solicitada é executada, preservando IDs/índices/ciclos/FIFO/Perguntas/respostas/reservas/limites/efeitos e referências necessárias.
- [x] Interrupção durante migração é detectável com caminho próprio de conclusão/recuperação; estado parcial não é aceito como operacional sem saída conhecida.
- [x] Nova release inicia pausada, reinstala registry compatível e reconcilia/permite inspeção antes de despausar; pergunta pendente continua respondível e retomada conserva contexto compatível ou substituição registrada.
- [x] Discos/base/perfil não são migrados nem assets dependentes removidos implicitamente; release antiga só opera formato compatível, sem promessa de rolling update ou rollback universal.
- [x] Provas reais cobrem troca com Pergunta pendente, incompatibilidade recusada e migração suportada interrompida, usando fronteiras públicas sem edição operacional de storage.
- [x] Procedimento não adiciona backup/restauração integrado, agendamento ou certificação de cópias; proteção contra perda de storage permanece externa e não desfaz GitHub.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.2, 6.1, 11.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-01, V-07, V-12, V-16 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-15: atualização explícita executada pela release nova sob o mesmo `flock` do storage (`upgrade check|apply|status|resume|rollback`). Verifica, antes de qualquer mudança, release alvo e anterior, `config.yaml`/perfil, backend/formato/documentos/registry do storage, pausa, evidência de parada limpa composta com a reconciliação de boot do 26, protocolo, perfil/skills/sessões e dependências de ambientes/assets; incompatível bloqueia sem apagar/ressubmeter. Storage formato 2 (identidade, registro de migração, ciclo do controlador); a única migração suportada (1 → 2) é pedida explicitamente, verificada antes do commit e feita em um commit, preservando IDs/índices/FIFO/Perguntas/reservas/limites/efeitos. Journal com launcher-guarda (nenhuma release roda durante o upgrade), reverificação antes de selecionar, `resume` e rollback só enquanto o formato é operável pela anterior (sem rollback universal, sem backup integrado). Gate local 1096/0 (177 arquivos, 10 skip). Ensaio real: r33-v1 inconclusivo por defeito da receita (lock criado 0644 por `flock` cru; recusas agora nomeiam causa e caminho; receita com vereditos), r33-v2 aprovado 54/54 com v1 real, Pergunta pendente respondida após a troca, recusas reais e dois SIGKILL durante a migração. Evidência: `docs/evidence/33-compatible-upgrades-and-recoverable-migration.md` e `docs/evidence/33-r33-v2/`.
