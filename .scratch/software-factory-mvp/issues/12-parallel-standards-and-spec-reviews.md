# 12: Obter Standards e Spec paralelos sobre a proposta completa

**What to build:** O Builder entrega a proposta completa para Standards e Spec independentes, que analisam em paralelo com leitura confinada e devolvem pareceres reais. Durante a revisão o Builder não atua, mas sua Execução continua ocupando um único Slot.

**Blocked by:** [09: Iniciar Builder com checkout próprio e pedido preservado](09-builder-start-and-preserved-request.md)

**Status:** resolved

## Acceptance criteria

- [x] Handoff registra rodada/tentativa, identidade do conteúdo/contexto, Git/base e versões de pedido/instruções/perfil, incluindo staged, não staged, novos/removidos e metadados pertinentes, sem exigir commit candidato ou worktree limpa.
- [x] Índice/diff/referências permitem leitura e contexto além dos hunks; Spec usa pedido preservado e Standards usa instruções preservadas, distinguindo heurística de violação documentada.
- [x] Host suspende turnos/ferramentas do Builder antes dos revisores e só libera após cessação da atividade deles; revisores compartilham Slot/relógio da Execução, não são dois Slots novos.
- [x] Cada papel tem sessão/modelo configurado e apenas read nativo com paginação/imagens e backend confinado, sem shell, busca/listagem própria, escrita, token, rede remota ou fallback host.
- [x] Parecer completo/durável precede notificação e inclui papel, sessão/modelo/perfil, entrada, cobertura justificada, conclusão/falha/cancelamento e achados por regra/requisito/local; streaming parcial não é parecer.
- [x] Fonte ilegível, truncamento não superado, revisor indisponível e contexto insuficiente impedem conclusão limpa, sem omitir Spec nem ampliar ferramentas.
- [x] Provas reais com os dois agentes demonstram leitura, paralelismo, confinamento e Builder inativo; mudança observada durante análise invalida a aplicabilidade necessária sem prometer congelamento adversarial.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.6, 6.3, 6.4, 7.5; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02, V-08 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-14: handoff com Builder suspenso, captura confinada da proposta, Standards+Spec paralelos com só leitura, opiniões duráveis, conclusão só com identidade inalterada e entrega após ambos. Gate local 902/0; ensaio real v4 com dois revisores reais concluindo `clean`. Evidência: `docs/evidence/12-parallel-standards-and-spec-reviews.md`.
